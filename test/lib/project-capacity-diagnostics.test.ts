import { describe, expect, it } from 'vitest';
import type {
	CapacityExecutionProvider,
	CapacityProviderMembershipView,
	CapacityReservation,
	DerivedCapacitySummary,
} from '@treeseed/sdk';
import type { CapacityGrantV2 } from '@treeseed/sdk/agent-capacity/allocation';
import {
	buildProjectCapacityDiagnostics,
	type ProjectCapacityDiagnosticsStore,
} from '../../src/api/capacity/services/project-capacity-diagnostics-service.ts';

function fixture<T>(value: Partial<T>): T {
	return value as T;
}

describe('project capacity diagnostics', () => {
	it('builds a read-only diagnostic projection without producing a governed decision capacity plan', async () => {
		let grantFilters: Record<string, unknown> | null = null;
		const provider = fixture<CapacityProviderMembershipView>({
			providerId: 'provider-a',
			identityStatus: 'active',
			membershipStatus: 'approved',
			identityMetadata: { quotaRemainingPercent: 75 },
		});
		const unrelatedProvider = fixture<CapacityProviderMembershipView>({
			providerId: 'provider-b',
			identityStatus: 'active',
			membershipStatus: 'approved',
		});
		const grant = fixture<CapacityGrantV2>({
			id: 'grant-a',
			providerId: provider.providerId,
			dailyCreditLimit: 10,
			monthlyCreditLimit: 100,
		});
		const reservation = fixture<CapacityReservation>({
			id: 'reservation-a',
			capacityProviderId: provider.providerId,
			state: 'reserved',
			reservedCredits: 3,
			metadata: { attentionWeight: 2 },
		});
		const executionProvider = fixture<CapacityExecutionProvider>({
			id: 'codex-a',
			providerId: provider.providerId,
			maxConcurrentRunners: 2,
			metadata: { maxAttentionLoad: 4 },
		});
		const derivedCapacity = fixture<DerivedCapacitySummary>({ totalDerivedAvailableCredits: 7 });
		const store: ProjectCapacityDiagnosticsStore = {
			ensureInitialized: async () => undefined,
			getProject: async () => ({ id: 'project-a', teamId: 'team-a' }),
			listCapacityGrantsPage: async (_teamId, filters) => {
				grantFilters = filters;
				return { items: [grant], page: { limit: 200, hasMore: false, nextCursor: null } };
			},
			getCapacityProvider: async (_teamId, providerId) => providerId === provider.providerId ? provider : unrelatedProvider,
			listProviderExecutionSnapshots: async () => [executionProvider],
			listCapacityReservationsForProjectPage: async () => ({ items: [reservation], page: { limit: 200, hasMore: false, nextCursor: null } }),
			getTeamDerivedCapacity: async () => derivedCapacity,
			getCapacityCreditReservationTotals: async () => ({
				activeReservedCredits: 3,
				dailyUsedCredits: 0,
				monthlyUsedCredits: 0,
				dailyCommittedCredits: 3,
				monthlyCommittedCredits: 3,
				dailyWindowStartAt: '2026-07-17T00:00:00.000Z',
				monthlyWindowStartAt: '2026-07-01T00:00:00.000Z',
			}),
		};

		const diagnostics = await buildProjectCapacityDiagnostics(store, 'project-a', 'local');

		expect(diagnostics).toMatchObject({
			projectId: 'project-a',
			teamId: 'team-a',
			environment: 'local',
			remaining: { dailyCredits: 7, monthlyCredits: 100 },
		});
		expect(diagnostics?.providers.map((entry) => entry.providerId)).toEqual(['provider-a']);
		expect(diagnostics?.executionProviders.map((entry) => entry.id)).toEqual(['codex-a']);
		expect(diagnostics?.providers[0]?.identityMetadata?.pressure).toMatchObject({
			activeReservations: 1,
			maxActiveReservations: 2,
			congestionRatio: 0.5,
			activeAttentionLoad: 2,
			quotaRemainingPercent: 75,
		});
		expect(diagnostics).not.toHaveProperty('workUnits');
		expect(diagnostics).not.toHaveProperty('status');
		expect(grantFilters).toMatchObject({ projectId: 'project-a', environment: 'local', status: 'active' });
	});

	it('returns null for an unknown project', async () => {
		const store = {
			ensureInitialized: async () => undefined,
			getProject: async () => null,
		} as unknown as ProjectCapacityDiagnosticsStore;
		expect(await buildProjectCapacityDiagnostics(store, 'missing')).toBeNull();
	});
});
