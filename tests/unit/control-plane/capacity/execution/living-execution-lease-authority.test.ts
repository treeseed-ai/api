import { describe, expect, it, vi } from 'vitest';
import { evaluateProviderAssignmentLeaseAuthority } from '../../../../../src/api/capacity/services/accounts/lease-authority-service.ts';
import { ControlPlaneStore } from '../../../../../src/api/persistence/store.ts';

describe('living execution lease authority', () => {
	it('rejects expired malformed and coerced reservation workspace and availability clocks against the unchanged original current time', async () => {
		const now = '2026-09-14T01:00:00.000Z', future = '2026-09-14T02:00:00.000Z';
		const baseline = {
			assignment: { id: 'assignment', membership_id: 'membership', synthesized_from: 'living_execution_graph', status: 'pending', reservation_id: 'reservation', work_day_id: 'workday' },
			membership: { membership_status: 'approved', provider_status: 'active' },
			reservation: { state: 'reserved', expires_at: future }, workday: { status: 'running' },
			proxy: { status: 'issued', expires_at: future },
			session: { id: 'session', status: 'open', available_from: '2026-09-14T00:00:00.000Z', available_until: future, expires_at: future },
		};
		const principal = { membershipId: 'membership', teamId: 'team', capacityProviderId: 'provider' };
		const cases: Array<{ owner: 'reservation' | 'proxy' | 'session'; field: string; value: unknown; reason: string }> = [];
		for (const [owner, field, invalid, expired] of [
			['reservation', 'expires_at', 'reservation_time_invalid', 'reservation_expired'],
			['proxy', 'expires_at', 'assignment_workspace_time_invalid', 'assignment_workspace_expired'],
			['session', 'available_until', 'availability_time_invalid', 'availability_window_expired'],
			['session', 'expires_at', 'availability_time_invalid', 'availability_window_expired'],
		] as const) {
			for (const value of ['', 'malformed', 1, true]) cases.push({ owner, field, value, reason: invalid });
			for (const value of [now, '2026-09-14T00:59:59.999Z']) cases.push({ owner, field, value, reason: expired });
		}
		for (const value of ['', 'malformed', 1, true]) cases.push({ owner: 'session', field: 'available_from', value, reason: 'availability_time_invalid' });
		cases.push({ owner: 'session', field: 'available_from', value: future, reason: 'availability_window_not_started' });
		for (const scenario of [null, ...cases]) {
			const rows = structuredClone(baseline);
			if (scenario) Object.assign(rows[scenario.owner], { [scenario.field]: scenario.value });
			const before = structuredClone(rows); let writes = 0;
			const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
				prepare: (sql: string) => ({ bind: () => ({ first: async () => {
					if (sql.includes('FROM capacity_provider_assignments')) return rows.assignment;
					if (sql.includes('FROM capacity_provider_team_memberships')) return rows.membership;
					if (sql.includes('FROM capacity_reservations')) return rows.reservation;
					if (sql.includes('FROM capacity_workday_runs')) return rows.workday;
					if (sql.includes('FROM treedx_proxy_handles')) return rows.proxy;
					if (sql.includes('FROM capacity_provider_availability_sessions')) return rows.session;
					throw new Error('Unexpected lease authority read');
				}, all: async () => { throw new Error('Unexpected lease inventory read'); }, run: async () => { writes++; throw new Error('Unexpected lease authority write'); } }) }),
				batch: async () => { writes++; throw new Error('Unexpected lease transaction'); },
			});
			store.initializationPromise = Promise.resolve();
			const originalRun = store.run.bind(store);
			const database = Object.assign(store, { run: async (sql: string, params: unknown[] = []) => { await originalRun(sql, params); } });
			const result = await evaluateProviderAssignmentLeaseAuthority(database, principal, 'assignment', now, 'session');
			expect(result, JSON.stringify(scenario)).toMatchObject({ eligible: !scenario, reasons: scenario ? [scenario.reason] : [] });
			expect(rows).toEqual(before); expect(writes).toBe(0);
			await expect(evaluateProviderAssignmentLeaseAuthority(database, principal, 'assignment', 'malformed', 'session'))
				.resolves.toMatchObject({ eligible: false, reasons: ['lease_time_invalid'] });
			expect(rows).toEqual(before); expect(writes).toBe(0);
		}
	});
	it('uses the exact reservation and active workday run without retired grant or allocation gates', async () => {
		const first = vi.fn(async (query: string) => {
			if (query.includes('FROM capacity_provider_assignments')) return {
				id: 'assignment', membership_id: 'membership', team_id: 'team', project_id: 'project',
				capacity_provider_id: 'provider', reservation_id: 'reservation', work_day_id: 'workday',
				synthesized_from: 'living_execution_graph', status: 'pending', lease_state: 'unleased',
			};
			if (query.includes('FROM capacity_provider_team_memberships')) return { membership_status: 'approved', provider_status: 'active' };
			if (query.includes('FROM capacity_reservations')) return { state: 'reserved', grant_status: null, allocation_status: null };
			if (query.includes('FROM capacity_workday_runs')) return { status: 'running' };
			if (query.includes('FROM treedx_proxy_handles')) return { status: 'issued' };
			if (query.includes('FROM capacity_provider_availability_sessions')) return {
				id: 'session', status: 'open', available_until: '2026-09-14T03:00:00.000Z',
			};
			throw new Error(`Unexpected query: ${query}`);
		});
		const result = await evaluateProviderAssignmentLeaseAuthority({ ensureInitialized: async () => undefined, first } as never,
			{ membershipId: 'membership', teamId: 'team', capacityProviderId: 'provider' }, 'assignment',
			'2026-09-14T01:00:00.000Z', 'session');
		expect(result).toMatchObject({ eligible: true, reasons: [], gates: {
			assignmentAuthority: 'living_execution_graph', reservationState: 'reserved',
			workdayStatus: 'running', sessionStatus: 'open',
		} });
		expect(first.mock.calls.some(([query]) => /workday_capacity_envelopes|capacity_allocation_sets/u.test(String(query)))).toBe(false);
	});
	it('rejects retired assignment authority without querying another allocator', async () => {
		const first = vi.fn(async () => ({ synthesized_from: 'workday_demand' }));
		await expect(evaluateProviderAssignmentLeaseAuthority({ ensureInitialized: async () => undefined, first } as never,
			{ membershipId: 'membership', teamId: 'team', capacityProviderId: 'provider' }, 'assignment'))
			.resolves.toMatchObject({ eligible: false, reasons: ['assignment_graph_authority_required'] });
		expect(first).toHaveBeenCalledOnce();
	});
	it('continues a live lease when the same provider rotates availability, but does not revive an expired lease or an explicit old-session claim', async () => {
		const first = vi.fn(async (query: string) => {
			if (query.includes('FROM capacity_provider_assignments')) return {
				id: 'assignment', membership_id: 'membership', team_id: 'team', capacity_provider_id: 'provider',
				reservation_id: 'reservation', work_day_id: 'workday', provider_session_id: 'old',
				synthesized_from: 'living_execution_graph', status: 'leased', lease_state: 'leased',
				lease_expires_at: '2026-09-14T01:05:00.000Z',
			};
			if (query.includes('FROM capacity_provider_team_memberships')) return { membership_status: 'approved', provider_status: 'active' };
			if (query.includes('FROM capacity_reservations')) return { state: 'reserved' };
			if (query.includes('FROM capacity_workday_runs')) return { status: 'running' };
			if (query.includes('FROM treedx_proxy_handles')) return { status: 'issued' };
			if (query.includes("status = 'open'")) return { id: 'new', status: 'open', available_until: '2026-09-14T01:10:00.000Z' };
			if (query.includes('FROM capacity_provider_availability_sessions')) return { id: 'old', status: 'closed' };
			throw new Error(`Unexpected query: ${query}`);
		});
		const database = { ensureInitialized: async () => undefined, first } as never;
		const principal = { membershipId: 'membership', teamId: 'team', capacityProviderId: 'provider' };
		await expect(evaluateProviderAssignmentLeaseAuthority(database, principal, 'assignment', '2026-09-14T01:00:00.000Z'))
			.resolves.toMatchObject({ eligible: true, sessionId: 'new', reasons: [] });
		await expect(evaluateProviderAssignmentLeaseAuthority(database, principal, 'assignment', '2026-09-14T01:00:00.000Z', 'old'))
			.resolves.toMatchObject({ eligible: false, reasons: ['availability_session_not_open'] });
		await expect(evaluateProviderAssignmentLeaseAuthority(database, principal, 'assignment', '2026-09-14T01:06:00.000Z'))
			.resolves.toMatchObject({ eligible: false, reasons: ['availability_session_not_open'] });
	});
});
