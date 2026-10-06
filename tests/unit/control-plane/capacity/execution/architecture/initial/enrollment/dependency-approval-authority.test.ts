import type { ProviderRegistrationRequest } from '@treeseed/sdk/capacity-provider/contracts';
import { describe, expect, it, vi } from 'vitest';
import { CapacityGovernanceError, type CapacityDatabaseOperation, type CapacityGovernanceDatabase } from '../../../../../../../../src/api/capacity/database.ts';
import { CapacityGovernanceRepository } from '../../../../../../../../src/api/capacity/repositories/governance/policy/governance.ts';
import { revocationGuard } from '../credentials/dependency-revocation-fixture.ts';
import { CapacityRegistrationService } from '../../../../../../../../src/api/capacity/services/support/registration-service.ts';
import { CapacitySecretCodec, canonicalJson, sha256 } from '../../../../../../../../src/api/capacity/security.ts';

// Controlled unit DTO, not native registration/authentication or productive authority.
function pendingApprovalInput(): ProviderRegistrationRequest {
	const now = new Date();
	return { id: 'request', teamId: 'team', providerId: 'provider', providerFingerprint: 'supplied-fingerprint', registrationKeyGeneration: 1, status: 'pending', capabilitySummary: ['renamed.execution'], supplyOffer: { capabilities: ['renamed.execution'], weight: 1, maxConcurrentRunners: 1 }, expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(), reviewedAt: null, reviewedById: null, rejectionReason: null, membershipId: null, metadata: { source: 'controlled-unit-input' } };
}

describe('original registration approval authority', () => {
	it('original approval denies missing foreign terminal and elapsed request inputs before enrollment or audit without rewriting authority', async () => {
		const pending = pendingApprovalInput();
		const cases: { row: ProviderRegistrationRequest | null; status: number; code: string }[] = [
			{ row: null, status: 404, code: 'provider_registration_not_found' }, { row: { ...pending, teamId: 'foreign-team' }, status: 404, code: 'provider_registration_not_found' },
			...(['rejected', 'cancelled', 'expired'] as const).map(status => ({ row: { ...pending, status }, status: 409, code: 'provider_registration_not_pending' })),
			{ row: { ...pending, expiresAt: '2000-01-01T00:00:00.000Z' }, status: 409, code: 'provider_registration_not_pending' },
		];
		for (const test of cases) {
			const input = { team: 'team', request: pending.id, actor: 'supplied-operator', key: 'denied-approval', alias: 'renamed-provider' }, original = structuredClone({ input, row: test.row }); let reads = 0, writes = 0;
			const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined, first: async () => { reads++; throw new Error('Unexpected unit SQL read'); }, all: async () => { reads++; throw new Error('Unexpected unit SQL list'); }, run: async () => { writes++; throw new Error('Unexpected unit audit write'); }, batch: async () => { writes++; throw new Error('Unexpected unit enrollment transaction'); } };
			const repository = new CapacityGovernanceRepository(database), service = new CapacityRegistrationService(repository, new CapacitySecretCodec('controlled-unit-hash-material-only', 'controlled-unit-envelope-material-only'), 'http://localhost');
			const team = vi.spyOn(repository, 'teamExists').mockResolvedValue(true), expiry = vi.spyOn(repository, 'expireRegistrationRequest').mockResolvedValue(test.row), transition = vi.spyOn(repository, 'registrationRequestTransitionEvidence').mockResolvedValue(null), admission = vi.spyOn(repository, 'approveRequest');
			try {
				let error: unknown; try { await service.approve(input.team, input.request, input.actor, input.key, input.alias); } catch (caught) { error = caught; }
				expect(error).toBeInstanceOf(CapacityGovernanceError); expect(error).toMatchObject({ status: test.status, code: test.code }); expect(team).toHaveBeenCalledOnce(); expect(team.mock.calls[0]).toEqual([input.team]); expect(expiry).toHaveBeenCalledOnce(); expect(admission).not.toHaveBeenCalled();
				expect(expiry.mock.calls[0]?.[0]).toBe(input.request); expect(transition).toHaveBeenCalledTimes(test.status === 404 ? 0 : 1);
				expect(reads).toBe(0); expect(writes).toBe(0); expect({ input, row: test.row }).toEqual(original);
			} finally { team.mockRestore(); expiry.mockRestore(); transition.mockRestore(); admission.mockRestore(); }
		}
	});
	it('original approval rejects a lost conditional transition or foreign winning key without recording a successful approval audit', async () => {
		const pending = pendingApprovalInput();
		for (const row of [null, { ...pending, status: 'rejected' as const }, { ...pending, status: 'cancelled' as const }, { ...pending, status: 'approved' as const, membershipId: 'competing-member' }]) {
			const input = { team: 'team', request: pending.id, actor: 'supplied-operator', key: 'losing-approval', alias: 'renamed-provider' }, original = structuredClone({ input, pending, row }); let writes = 0;
			const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined, first: async () => { throw new Error('Unexpected unit SQL read'); }, all: async () => { throw new Error('Unexpected unit SQL list'); }, run: async () => { writes++; throw new Error('Unexpected losing approval audit'); }, batch: async () => { writes++; throw new Error('Unexpected separate unit transaction'); } };
			const repository = new CapacityGovernanceRepository(database), service = new CapacityRegistrationService(repository, new CapacitySecretCodec('controlled-unit-hash-material-only', 'controlled-unit-envelope-material-only'), 'http://localhost');
			const team = vi.spyOn(repository, 'teamExists').mockResolvedValue(true), expiry = vi.spyOn(repository, 'expireRegistrationRequest').mockResolvedValue(pending), transition = vi.spyOn(repository, 'registrationRequestTransitionEvidence').mockResolvedValue({ transition_action: 'approve', transition_idempotency_key: 'competing-approval', transition_request_digest: 'controlled-competing-digest' }).mockResolvedValueOnce(null), admission = vi.spyOn(repository, 'approveRequest').mockResolvedValue(row);
			try {
				let error: unknown; try { await service.approve(input.team, input.request, input.actor, input.key, input.alias); } catch (caught) { error = caught; }
				expect(error).toBeInstanceOf(CapacityGovernanceError); expect(error).toMatchObject({ status: 409, code: 'provider_registration_state_conflict' }); expect(admission).toHaveBeenCalledOnce();
				expect(admission.mock.calls[0]?.[0]).toMatchObject({ requestId: input.request, actorId: input.actor, teamAlias: input.alias, idempotencyKey: input.key }); expect(writes).toBe(0); expect({ input, pending, row }).toEqual(original);
			} finally { team.mockRestore(); expiry.mockRestore(); transition.mockRestore(); admission.mockRestore(); }
		}
	});
	it('empty original approval key denies with the owning governance error before any repository reads writes or authority mutation', async () => {
		const f = revocationGuard(), input = { team: 'team', request: 'request', actor: 'supplied-operator', key: '', alias: 'renamed-provider' }, before = structuredClone(input);
		let error: unknown; try { await f.service.approve(input.team, input.request, input.actor, input.key, input.alias); } catch (caught) { error = caught; }
		expect(error).toBeInstanceOf(CapacityGovernanceError); expect(error).toMatchObject({ status: 400, code: 'idempotency_key_required' });
		expect(f.reads()).toBe(0); expect(f.writes()).toBe(0); expect(input).toEqual(before);
	});
	it('original approval repository binds request membership and pending authorization in one batch before readback preserving inputs and the same failure cause', async () => {
		const input = { requestId: 'request', membershipId: 'new-member', authorizationId: 'new-authorization', actorId: 'supplied-operator', teamAlias: 'renamed-provider', idempotencyKey: 'approve-original', requestDigest: 'supplied-original-digest', now: '2026-10-03T17:39:14.000Z' }, before = structuredClone(input);
		const batches: CapacityDatabaseOperation[][] = []; let reads = 0, ready = 0, release: (value: unknown) => void = () => { throw new Error('Owned batch barrier missing'); };
		const barrier = new Promise<unknown>(resolve => { release = resolve; });
		const database: CapacityGovernanceDatabase = { ensureInitialized: async () => { ready++; }, run: async () => { throw new Error('Unexpected separate write'); },
			first: async (query, params) => { reads++; expect(query).toBe('SELECT * FROM capacity_provider_registration_requests WHERE id = ? LIMIT 1'); expect(params).toEqual([input.requestId]); return null; },
			all: async () => { throw new Error('Unexpected list read'); }, batch: operations => { batches.push(structuredClone(operations)); return barrier; } };
		const pending = new CapacityGovernanceRepository(database).approveRequest(input); void pending.catch(() => undefined);
		try {
			expect(reads).toBe(0); expect(ready).toBe(0); expect(batches).toHaveLength(1); const operations = batches[0]!; expect(operations).toHaveLength(3);
			expect(operations[0]?.query).toContain("WHERE id = ? AND status = 'pending' AND expires_at > ?");
			expect(operations[0]?.params).toEqual([input.now, input.actorId, input.membershipId, input.idempotencyKey, input.requestDigest, input.now, input.requestId, input.now]);
			expect(operations[1]?.query).toContain("FROM capacity_provider_registration_requests WHERE id = ? AND status = 'approved' AND membership_id = ?");
			expect(operations[1]?.params).toEqual([input.membershipId, input.teamAlias, input.now, input.actorId, input.now, input.now, input.requestId, input.membershipId]);
			expect(operations[2]?.query).toContain("'pending', 'team-principal'");
			expect(operations[2]?.params).toEqual([input.authorizationId, `approval:${input.requestId}`, input.actorId, input.now, input.now, input.membershipId]);
			release([]); expect(await pending).toBeNull(); expect(reads).toBe(1); expect(ready).toBe(1); expect(input).toEqual(before);
		} finally { release([]); await Promise.allSettled([pending]); }
		const cause = new Error('Controlled original approval batch failure'); let failedReads = 0, failedBatches = 0;
		const failed: CapacityGovernanceDatabase = { ...database, first: async () => { failedReads++; return null; }, batch: async () => { failedBatches++; throw cause; } };
		await expect(new CapacityGovernanceRepository(failed).approveRequest(input)).rejects.toBe(cause); expect(failedBatches).toBe(1); expect(failedReads).toBe(0); expect(input).toEqual(before);
	});
});

it('original terminal rejection refuses unbound replay keys before transition or audit even when the requested reason matches the winner', async () => {
	const pending = pendingApprovalInput(), row: ProviderRegistrationRequest = { ...pending, status: 'rejected', reviewedById: 'original-winning-operator', reviewedAt: pending.updatedAt, rejectionReason: 'Original winning reason' };
	const evidence = { transition_action: 'reject', transition_idempotency_key: 'original-winning-key', transition_request_digest: sha256(canonicalJson({ action: 'reject', reason: row.rejectionReason })) };
	for (const test of [{ reason: '  Original winning reason  ', evidence }, { reason: 'Changed unbound reason', evidence }, { reason: 'Original winning reason', evidence: null }]) {
		const input = { team: 'team', request: row.id, actor: 'different-caller-operator', key: 'unbound-replay-key', reason: test.reason }, original = structuredClone({ row, test, input }); let reads = 0, writes = 0;
		const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined, first: async () => { reads++; throw new Error('Unexpected terminal replay SQL read'); }, all: async () => { reads++; throw new Error('Unexpected terminal replay SQL list'); }, run: async () => { writes++; throw new Error('Unexpected unbound replay audit'); }, batch: async () => { writes++; throw new Error('Unexpected unbound replay enrollment'); } };
		const repository = new CapacityGovernanceRepository(database), service = new CapacityRegistrationService(repository, new CapacitySecretCodec('controlled-unit-hash-material-only', 'controlled-unit-envelope-material-only'), 'http://localhost');
		const team = vi.spyOn(repository, 'teamExists').mockResolvedValue(true), expiry = vi.spyOn(repository, 'expireRegistrationRequest').mockResolvedValue(row), transition = vi.spyOn(repository, 'registrationRequestTransitionEvidence').mockResolvedValue(test.evidence), rejection = vi.spyOn(repository, 'rejectRequest');
		try {
			let error: unknown; try { await service.reject(input.team, input.request, input.actor, input.reason, input.key); } catch (caught) { error = caught; }
			expect(error).toBeInstanceOf(CapacityGovernanceError); expect(error).toMatchObject({ status: 409, code: 'provider_registration_not_pending' });
			expect(team.mock.calls).toEqual([[input.team]]); expect(expiry.mock.calls).toEqual([[input.request, expect.any(String)]]); expect(transition.mock.calls).toEqual([[input.request]]); expect(rejection).not.toHaveBeenCalled();
			expect(reads).toBe(0); expect(writes).toBe(0); expect({ row, test, input }).toEqual(original);
		} finally { team.mockRestore(); expiry.mockRestore(); transition.mockRestore(); rejection.mockRestore(); }
	}
});

it('original approval refuses changed winning alias digest under the same key before audit and retains exact conditional enrollment inputs', async () => {
	const pending = pendingApprovalInput(), input = { team: 'team', request: pending.id, actor: 'supplied-operator', key: 'same-approval-key', alias: 'Original losing alias' };
	const row: ProviderRegistrationRequest = { ...pending, status: 'approved', membershipId: 'winning-membership', reviewedById: input.actor };
	const digest = sha256(canonicalJson({ action: 'approve', teamAlias: input.alias })), evidence = { transition_action: 'approve', transition_idempotency_key: input.key, transition_request_digest: sha256(canonicalJson({ action: 'approve', teamAlias: 'Changed winning alias' })) };
	const original = structuredClone({ pending, input, row, evidence }); let reads = 0, writes = 0;
	const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined, first: async () => { reads++; throw new Error('Unexpected approval digest SQL read'); }, all: async () => { reads++; throw new Error('Unexpected approval digest SQL list'); }, run: async () => { writes++; throw new Error('Unexpected losing approval audit'); }, batch: async () => { writes++; throw new Error('Unexpected separate enrollment'); } };
	const repository = new CapacityGovernanceRepository(database), service = new CapacityRegistrationService(repository, new CapacitySecretCodec('controlled-unit-hash-material-only', 'controlled-unit-envelope-material-only'), 'http://localhost');
	const team = vi.spyOn(repository, 'teamExists').mockResolvedValue(true), expiry = vi.spyOn(repository, 'expireRegistrationRequest').mockResolvedValue(pending), transition = vi.spyOn(repository, 'registrationRequestTransitionEvidence').mockResolvedValue(evidence).mockResolvedValueOnce(null), admission = vi.spyOn(repository, 'approveRequest').mockResolvedValue(row);
	try {
		let error: unknown; try { await service.approve(input.team, input.request, input.actor, input.key, input.alias); } catch (caught) { error = caught; }
		expect(error).toBeInstanceOf(CapacityGovernanceError); expect(error).toMatchObject({ status: 409, code: 'provider_registration_state_conflict' });
		expect(team).toHaveBeenCalledOnce(); expect(team.mock.calls[0]).toEqual([input.team]); expect(expiry).toHaveBeenCalledOnce(); expect(expiry.mock.calls[0]).toEqual([input.request, expect.any(String)]);
		expect(transition.mock.calls).toEqual([[input.request], [input.request]]); expect(admission).toHaveBeenCalledOnce(); const call = admission.mock.calls[0]![0];
		expect(call).toEqual({ requestId: input.request, membershipId: expect.any(String), authorizationId: expect.any(String), actorId: input.actor, teamAlias: input.alias, idempotencyKey: input.key, requestDigest: digest, now: expect.any(String) });
		expect(call.membershipId.length > 0 && call.authorizationId.length > 0 && call.membershipId !== call.authorizationId).toBe(true); expect(evidence.transition_request_digest).not.toBe(digest);
		expect(reads).toBe(0); expect(writes).toBe(0); expect({ pending, input, row, evidence }).toEqual(original);
	} finally { team.mockRestore(); expiry.mockRestore(); transition.mockRestore(); admission.mockRestore(); }
});

it('original rejection refuses a lost conditional transition or changed winning digest even when the winning key matches without recording a successful audit or rewriting inputs', async () => {
	const pending = pendingApprovalInput(), input = { team: 'team', request: pending.id, actor: 'supplied-operator', reason: '  Original losing rejection  ', key: 'unit-losing-rejection' };
	const digest = sha256(canonicalJson({ action: 'reject', reason: input.reason.trim() }));
	const cases: { row: ProviderRegistrationRequest | null; evidence: { transition_action: string; transition_idempotency_key: string; transition_request_digest: string } | null; evidenceReads: number }[] = [
		...([null, ...(['approved', 'cancelled', 'expired'] as const).map(status => ({ ...pending, status }))]).map(row => ({ row, evidence: null, evidenceReads: 1 })),
		{ row: { ...pending, status: 'rejected', rejectionReason: 'Foreign winner' }, evidence: { transition_action: 'reject', transition_idempotency_key: 'foreign-winning-key', transition_request_digest: digest }, evidenceReads: 2 },
		{ row: { ...pending, status: 'rejected', rejectionReason: 'Changed winning reason' }, evidence: { transition_action: 'reject', transition_idempotency_key: input.key, transition_request_digest: sha256(canonicalJson({ action: 'reject', reason: 'Changed winning reason' })) }, evidenceReads: 2 },
	];
	for (const test of cases) {
		const original = structuredClone({ pending, input, test }); let reads = 0, writes = 0;
		const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined, first: async () => { reads++; throw new Error('Unexpected lost rejection SQL read'); }, all: async () => { reads++; throw new Error('Unexpected lost rejection SQL list'); }, run: async () => { writes++; throw new Error('Unexpected losing rejection audit'); }, batch: async () => { writes++; throw new Error('Unexpected losing rejection enrollment'); } };
		const repository = new CapacityGovernanceRepository(database), service = new CapacityRegistrationService(repository, new CapacitySecretCodec('controlled-unit-hash-material-only', 'controlled-unit-envelope-material-only'), 'http://localhost');
		const team = vi.spyOn(repository, 'teamExists').mockResolvedValue(true), expiry = vi.spyOn(repository, 'expireRegistrationRequest').mockResolvedValue(pending), transition = vi.spyOn(repository, 'registrationRequestTransitionEvidence').mockResolvedValue(test.evidence).mockResolvedValueOnce(null), reject = vi.spyOn(repository, 'rejectRequest').mockResolvedValue(test.row);
		try {
			let error: unknown; try { await service.reject(input.team, input.request, input.actor, input.reason, input.key); } catch (caught) { error = caught; }
			expect(error).toBeInstanceOf(CapacityGovernanceError); expect(error).toMatchObject({ status: 409, code: 'provider_registration_state_conflict' }); expect(team).toHaveBeenCalledOnce(); expect(expiry).toHaveBeenCalledOnce(); expect(transition).toHaveBeenCalledTimes(test.evidenceReads); expect(reject).toHaveBeenCalledOnce();
			const call = reject.mock.calls[0]?.[0]; expect(call).toMatchObject({ requestId: input.request, actorId: input.actor, reason: input.reason.trim(), idempotencyKey: input.key, requestDigest: digest }); expect(call?.now).toBeTypeOf('string');
			expect(reads).toBe(0); expect(writes).toBe(0); expect({ pending, input, test }).toEqual(original);
		} finally { team.mockRestore(); expiry.mockRestore(); transition.mockRestore(); reject.mockRestore(); }
	}
});

it('original rejection validates key reason and missing foreign terminal authority before any review write and retains exact caller inputs', async () => {
	const pending = pendingApprovalInput();
	const cases: { key: string; reason: string; row: ProviderRegistrationRequest | null; status: number; code: string; lookup: boolean }[] = [
		{ key: '', reason: 'Controlled reason', row: pending, status: 400, code: 'idempotency_key_required', lookup: false },
		...['', ' \t\n '].map(reason => ({ key: 'rejection-key', reason, row: pending, status: 400, code: 'rejection_reason_required', lookup: false })),
		{ key: 'rejection-key', reason: 'Controlled reason', row: null, status: 404, code: 'provider_registration_not_found', lookup: true },
		{ key: 'rejection-key', reason: 'Controlled reason', row: { ...pending, teamId: 'foreign-team' }, status: 404, code: 'provider_registration_not_found', lookup: true },
		...(['approved', 'cancelled', 'expired'] as const).map(status => ({ key: 'rejection-key', reason: 'Controlled reason', row: { ...pending, status }, status: 409, code: 'provider_registration_not_pending', lookup: true })),
	];
	for (const test of cases) {
		const original = structuredClone({ pending, test }); let reads = 0, writes = 0;
		const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined, first: async () => { reads++; throw new Error('Unexpected rejection unit SQL read'); }, all: async () => { reads++; throw new Error('Unexpected rejection unit SQL list'); }, run: async () => { writes++; throw new Error('Unexpected denied rejection write'); }, batch: async () => { writes++; throw new Error('Unexpected rejection enrollment'); } };
		const repository = new CapacityGovernanceRepository(database), service = new CapacityRegistrationService(repository, new CapacitySecretCodec('controlled-unit-hash-material-only', 'controlled-unit-envelope-material-only'), 'http://localhost');
		const team = vi.spyOn(repository, 'teamExists').mockResolvedValue(true), expiry = vi.spyOn(repository, 'expireRegistrationRequest').mockResolvedValue(test.row), transition = vi.spyOn(repository, 'registrationRequestTransitionEvidence').mockResolvedValue(null), reject = vi.spyOn(repository, 'rejectRequest');
		try {
			let error: unknown; try { await service.reject('team', pending.id, 'supplied-operator', test.reason, test.key); } catch (caught) { error = caught; }
			expect(error).toBeInstanceOf(CapacityGovernanceError); expect(error).toMatchObject({ status: test.status, code: test.code });
			expect(team).toHaveBeenCalledTimes(test.key ? 1 : 0); expect(expiry).toHaveBeenCalledTimes(test.lookup ? 1 : 0); expect(transition).toHaveBeenCalledTimes(test.status === 409 ? 1 : 0);
			if (test.lookup) expect(expiry.mock.calls[0]?.[0]).toBe(pending.id);
			expect(reject).not.toHaveBeenCalled(); expect(reads).toBe(0); expect(writes).toBe(0); expect({ pending, test }).toEqual(original);
		} finally { team.mockRestore(); expiry.mockRestore(); transition.mockRestore(); reject.mockRestore(); }
	}
});

it('original rejection preserves the same late audit failure and recovers one missing audit on exact terminal replay without repeating its conditional transition', async () => {
	const pending = pendingApprovalInput(), reason = '  Controlled rejection evidence  ', key = 'unit-rejection-recovery', actor = 'supplied-operator';
	const rejected: ProviderRegistrationRequest = { ...pending, status: 'rejected', reviewedById: actor, reviewedAt: pending.createdAt, rejectionReason: reason.trim() };
	const digest = sha256(canonicalJson({ action: 'reject', reason: reason.trim() })), evidence = { transition_action: 'reject', transition_idempotency_key: key, transition_request_digest: digest };
	const original = structuredClone({ pending, rejected, reason, key, evidence }), cause = new Error('Controlled original rejection audit interruption'), auditInputs: unknown[][] = [];
	let interrupt = true, reads = 0;
	const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined, first: async () => { reads++; throw new Error('Unexpected rejection recovery SQL read'); }, all: async () => { reads++; throw new Error('Unexpected rejection recovery SQL list'); }, batch: async () => { throw new Error('Rejection must not enroll a provider'); },
		run: async (query, params) => { expect(query).toContain('INSERT INTO capacity_audit_events'); expect(query).toContain('ON CONFLICT DO NOTHING'); auditInputs.push(structuredClone(params ?? [])); if (interrupt) throw cause; return undefined; } };
	const repository = new CapacityGovernanceRepository(database), service = new CapacityRegistrationService(repository, new CapacitySecretCodec('controlled-unit-hash-material-only', 'controlled-unit-envelope-material-only'), 'http://localhost');
	const team = vi.spyOn(repository, 'teamExists').mockResolvedValue(true), expiry = vi.spyOn(repository, 'expireRegistrationRequest').mockResolvedValue(rejected).mockResolvedValueOnce(pending), transition = vi.spyOn(repository, 'registrationRequestTransitionEvidence').mockResolvedValue(evidence).mockResolvedValueOnce(null), reject = vi.spyOn(repository, 'rejectRequest').mockResolvedValue(rejected);
	try {
		await expect(service.reject('team', pending.id, actor, reason, key)).rejects.toBe(cause); expect(reject).toHaveBeenCalledOnce(); expect(auditInputs).toHaveLength(1);
		expect(reject.mock.calls[0]?.[0]).toMatchObject({ requestId: pending.id, actorId: actor, reason: reason.trim(), idempotencyKey: key, requestDigest: digest });
		interrupt = false; expect(await service.reject('team', pending.id, actor, reason, key)).toEqual(rejected);
		expect(reject).toHaveBeenCalledOnce(); expect(auditInputs).toHaveLength(2); expect(reads).toBe(0);
		for (const params of auditInputs) {
			expect(params).toHaveLength(13); expect(params.slice(1, 12)).toEqual(['team', pending.providerId, null, 'team-principal', actor, 'provider-registration.rejected', 'provider-registration-request', pending.id, pending.id, key, canonicalJson({ reason: reason.trim() })]); expect(params[12]).toBeTypeOf('string');
		}
		expect({ pending, rejected, reason, key, evidence }).toEqual(original);
	} finally { team.mockRestore(); expiry.mockRestore(); transition.mockRestore(); reject.mockRestore(); }
});
