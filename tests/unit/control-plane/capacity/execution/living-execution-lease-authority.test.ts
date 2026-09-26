import { describe, expect, it, vi } from 'vitest';
import { evaluateProviderAssignmentLeaseAuthority } from '../../../../../src/api/capacity/services/accounts/lease-authority-service.ts';

describe('living execution lease authority', () => {
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
