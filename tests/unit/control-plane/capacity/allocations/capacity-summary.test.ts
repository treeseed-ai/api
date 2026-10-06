import { describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
	provider: { identityStatus: 'active', membershipStatus: 'approved' },
	accounting: { dailyCommittedSeconds: 0, monthlyCommittedSeconds: 0, dailyActiveSeconds: 0, monthlyActiveSeconds: 0 },
}));
vi.mock('../../../../../src/api/capacity/repositories/capacity/providers/provider-identity.ts', () => ({
	CapacityProviderIdentityRepository: class { async listTeamMemberships() { return [fixtures.provider]; } },
}));
vi.mock('../../../../../src/api/capacity/services/capacity/accounting/agent-time-reservation-aggregation-service.ts', () => ({
	aggregateCapacityTimeReservations: async () => fixtures.accounting,
}));
vi.mock('../../../../../src/api/capacity/services/capacity/capacity-core/native-capacity-service.ts', () => ({
	NativeCapacityService: class { async team() { return { entries: [], availableNativeByUnit: {} }; } },
}));
import { CapacitySummaryService } from '../../../../../src/api/capacity/services/capacity/observability/capacity-summary-service.ts';

describe('capacity readiness after allocation migration', () => {
	it('requires provider authority and budget, not a retired allocation set', async () => {
		const diagnostics = { teamId: 'team', providers: [fixtures.provider], grants: [{ status: 'active', unmetered: true }] };
		const store = {
			ensureInitialized: async () => undefined,
			getProjectCapacityDiagnostics: async () => diagnostics,
			first: async (sql: string) => {
				if (sql.includes('capacity_allocation_sets')) throw new Error('Retired allocation read');
				return { grant_count: 1, daily_agent_seconds: 0, monthly_agent_seconds: 0 };
			},
		};
		const summary = await new CapacitySummaryService(store as never).project('project');
		expect(summary).toMatchObject({ readiness: 'ready', reasons: [] });
		expect(summary).not.toHaveProperty('allocationSet');
		diagnostics.providers = [];
		await expect(new CapacitySummaryService(store as never).project('project')).resolves
			.toMatchObject({ readiness: 'waiting_for_provider', reasons: ['no_active_provider'] });
	});
});
