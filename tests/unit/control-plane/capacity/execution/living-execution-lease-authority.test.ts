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
			assignmentAuthority: 'living_execution_graph', reservationState: 'reserved', grantStatus: null,
			allocationStatus: null, workdayStatus: 'running', sessionStatus: 'open',
		} });
		expect(first.mock.calls.some(([query]) => String(query).includes('workday_capacity_envelopes'))).toBe(false);
	});
});
