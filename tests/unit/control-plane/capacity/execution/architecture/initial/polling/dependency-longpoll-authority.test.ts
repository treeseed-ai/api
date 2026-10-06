import { describe, expect, it, vi } from 'vitest';
import { CapacityGovernanceError } from '../../../../../../../../src/api/capacity/database.ts';
import { ControlPlaneStore } from '../../../../../../../../src/api/persistence/store.ts';
import { resolveProviderSynthesisContext } from '../../../../../../../../src/api/capacity/services/capacity/providers/provider-synthesis-context-service.ts';
import { longpollGuard } from './dependency-longpoll-fixture.ts';

describe('longpoll original input and withdrawn caller authority', () => {
	it('current access token custody rejects withdrawn missing and malformed durable token authority before synthesis reads or writes without changing the principal', async () => {
		for (const token of [null, { status: 'revoked', expires_at: '9999-12-31T23:59:59.999Z' },
			{ status: 'expired', expires_at: '9999-12-31T23:59:59.999Z' },
			...[undefined, null, '', 'malformed', 1, '2000-01-01T00:00:00.000Z'].map(expires_at => ({ status: 'active', expires_at }))]) {
			const actor = { accessTokenId: 'own-token', teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider' };
			const input = { providerSessionId: 'session' }, original = structuredClone({ actor, input, token });
			const reads: Array<{ sql: string; params: unknown[] }> = []; let writes = 0;
			const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
				prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({ first: async () => {
					reads.push({ sql, params }); if (reads.length !== 1) throw new Error('Unexpected post-denial synthesis read'); return token;
				}, all: async () => { throw new Error('Unexpected post-denial inventory read'); }, run: async () => { writes++; throw new Error('Unexpected token authority write'); } }) }),
				batch: async () => { writes++; throw new Error('Unexpected token authority transaction'); },
			});
			store.initializationPromise = Promise.resolve();
			const originalRun = store.run.bind(store);
			const owner = Object.assign(store, { run: async (sql: string, params: unknown[] = []) => { await originalRun(sql, params); } });
			await expect(resolveProviderSynthesisContext(owner, actor, input)).rejects.toMatchObject({ status: 401, code: 'provider_authentication_required' });
			expect(reads).toEqual([{ sql: `SELECT status,expires_at FROM capacity_provider_access_tokens
			WHERE id=? AND membership_id=? LIMIT 1`, params: ['own-token', 'membership'] }]);
			expect(writes).toBe(0); expect({ actor, input, token }).toEqual(original);
		}
	});
	it('abort during pending subscription releases the late listener without another lease and preserves the original response and fresh retry', async () => {
		let ready: (() => void) | undefined;
		const gate = new Promise<void>(resolve => { ready = resolve; });
		const f = longpollGuard(false, gate), controller = new AbortController();
		const body = { waitSeconds: 1, leaseSeconds: 30, laneId: 'workday', lanePurpose: 'workday' }, input = structuredClone(body);
		const pending = f.service.next(f.auth, body, controller.signal);
		try {
			await vi.waitFor(() => expect(f.counts().subscriptions).toBe(1));
			expect(f.counts().leases).toBe(1); expect(f.releases()).toBe(0);
			controller.abort(); const atAbort = f.counts(); ready?.();
			expect(await pending).toEqual({ assignment: null, leaseToken: null, leaseSeconds: 30, diagnostics: null, leaseDiagnostics: null });
			expect(f.counts()).toEqual(atAbort); expect(f.releases()).toBe(1); expect(f.inputs()).toEqual([input]);
			f.wake(); f.wake(); await Promise.resolve(); expect(f.counts()).toEqual(atAbort); expect(f.releases()).toBe(1);
			const retry = { ...body, waitSeconds: 0 }, retryInput = structuredClone(retry);
			expect(await f.service.next(f.auth, retry)).toEqual({ assignment: null, leaseToken: null, leaseSeconds: 30, diagnostics: null, leaseDiagnostics: null });
			// A fresh request performs the same three original reconciliation reads
			// as its predecessor. This is not post-abort work by the old request.
			expect(atAbort.reads).toBe(3);
			expect(f.counts()).toEqual({ ...atAbort, reads: atAbort.reads + 3, leases: atAbort.leases + 1 });
			expect(f.inputs()).toEqual([input, retryInput]); expect(f.releases()).toBe(1);
			expect(body).toEqual(input); expect(retry).toEqual(retryInput);
		} finally { controller.abort(); ready?.(); await pending; }
	});
	it('original availability context admits one millisecond before expiry and rejects exact or later expiry without writes clock widening or input mutation', async () => {
		const deadline = '2026-10-03T16:00:03.000Z', expiry = Date.parse(deadline);
		for (const field of ['available_until', 'expires_at'] as const) for (const offset of [-1, 0, 1]) {
			const session = { id: 'session', membership_id: 'membership', team_id: 'team', capacity_provider_id: 'provider',
				status: 'open', closed_at: null, environment: null, available_from: '2026-10-03T16:00:00.000Z',
				available_until: field === 'available_until' ? deadline : null, expires_at: deadline, execution_providers_json: '[]' };
			const principal = { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider' };
			const input = { providerSessionId: 'session', now: new Date(expiry + offset).toISOString() };
			const original = structuredClone({ session, principal, input }); let reads = 0, writes = 0;
			const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
				prepare: (sql: string) => ({ bind: () => ({ first: async () => {
					reads++; return sql.includes('JOIN capacity_providers') ? { provider_id: 'provider', provider_status: 'active' } : session;
				}, all: async () => { reads++; return { results: [] }; },
					run: async () => { writes++; throw new Error('Unexpected unit availability write'); } }) }),
				batch: async () => { writes++; throw new Error('Unexpected unit availability transaction'); },
			});
			store.initializationPromise = Promise.resolve();
			const originalRun = store.run.bind(store);
			const owner = Object.assign(store, { run: async (sql: string, params: unknown[] = []) => { await originalRun(sql, params); } });
			if (offset < 0) {
				const result = await resolveProviderSynthesisContext(owner, principal, input);
				expect(result).toMatchObject({ now: input.now, session: { id: 'session', availableUntil: session.available_until, expiresAt: deadline }, executionProviders: [] });
				expect(reads).toBe(3);
			} else {
				let failure: unknown; try { await resolveProviderSynthesisContext(owner, principal, input); } catch (error) { failure = error; }
				expect(failure).toBeInstanceOf(CapacityGovernanceError);
				if (!(failure instanceof CapacityGovernanceError)) throw new Error('Original expiry denial required');
				expect(failure.code).toBe('provider_synthesis_window_expired'); expect(failure.status).toBe(409);
				expect(failure.details).toEqual({ sessionId: 'session' }); expect(reads).toBe(2);
			}
			expect(writes).toBe(0); expect({ session, principal, input }).toEqual(original);
		}
	});
	it('caller mutation after subscription cannot rebind later owning polls or rewrite the caller object and released wake callbacks cannot revive the request', async () => {
		const f = longpollGuard(), controller = new AbortController();
		const body = { providerSessionId: 'original-session', runnerId: 'original-runner', leaseSeconds: 30,
			laneId: 'original-lane', lanePurpose: 'workday', waitSeconds: 1 }, original = structuredClone(body);
		const pending = f.service.next(f.auth, body, controller.signal);
		try {
			await vi.waitFor(() => expect(f.counts().leases).toBeGreaterThanOrEqual(2));
			expect(f.counts().subscriptions).toBe(1);
			Object.assign(body, { providerSessionId: 'foreign-session', runnerId: 'replacement-runner', leaseSeconds: 60,
				laneId: 'replacement-lane', lanePurpose: 'communication', waitSeconds: 30 });
			const changed = structuredClone(body), count = f.counts().leases;
			f.wake(); await vi.waitFor(() => expect(f.counts().leases).toBeGreaterThan(count));
			controller.abort();
			expect(await pending).toEqual({ assignment: null, leaseToken: null, leaseSeconds: 30, diagnostics: null, leaseDiagnostics: null });
			for (const input of f.inputs()) expect(input).toEqual(original);
			expect(body).toEqual(changed); expect(f.releases()).toBe(1); expect(f.counts().writes).toBe(0);
			const final = f.counts(); f.wake(); f.wake(); await Promise.resolve();
			expect(f.counts()).toEqual(final); expect(f.releases()).toBe(1); expect(body).toEqual(changed);
		} finally { controller.abort(); await pending; }
	});
	it('malformed coerced negative and oversized wait authority denies before reconciliation lease or subscription without rewriting inputs', async () => {
		for (const waitSeconds of [undefined, 0]) {
			const f = longpollGuard(), body = { waitSeconds, leaseSeconds: 30 }, before = structuredClone(body);
			expect(await f.service.next(f.auth, body)).toEqual({ assignment: null, leaseToken: null, leaseSeconds: 30, diagnostics: null, leaseDiagnostics: null });
			expect(body).toEqual(before); expect(f.counts().leases).toBe(1); expect(f.counts().subscriptions).toBe(0);
		}
		for (const waitSeconds of ['', ' ', '1', null, true, [], {}, -1, 31, Number.NaN, Infinity, -Infinity]) {
			const f = longpollGuard(true), body = { waitSeconds, laneId: 'workday', lanePurpose: 'workday' };
			const before = structuredClone(body); let failure: unknown;
			try { await f.service.next(f.auth, body); } catch (error) { failure = error; }
			expect(failure).toBeInstanceOf(CapacityGovernanceError);
			if (!(failure instanceof CapacityGovernanceError)) throw new Error('Original governance denial required');
			expect(failure.status).toBe(400); expect(body).toEqual(before);
			expect(f.counts()).toEqual({ reads: 0, writes: 0, leases: 0, subscriptions: 0 });
		}
	});
	it('preaborted caller returns the empty original poll envelope before reconciliation lease or subscription and retains inputs', async () => {
		const f = longpollGuard(), controller = new AbortController(); controller.abort();
		const body = { waitSeconds: 1, leaseSeconds: 30, laneId: 'workday', lanePurpose: 'workday' }, before = structuredClone(body);
		expect(await f.service.next(f.auth, body, controller.signal)).toMatchObject({ assignment: null, leaseToken: null, leaseSeconds: 30 });
		expect(body).toEqual(before); expect(f.counts()).toEqual({ reads: 0, writes: 0, leases: 0, subscriptions: 0 });
	});
});
