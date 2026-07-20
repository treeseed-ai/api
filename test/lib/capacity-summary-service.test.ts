import { describe, expect, it, vi } from 'vitest';
import type { CapacityAllocationSetV2, ProjectCapacityDiagnostics } from '@treeseed/sdk';
import { CapacitySummaryService } from '../../src/api/capacity/services/capacity-summary-service.ts';

function membershipRow() {
	return {
		provider_id: 'provider-a', fingerprint: 'sha256:a',
		public_jwk_json: '{"kty":"OKP","crv":"Ed25519","x":"public-a","alg":"EdDSA"}',
		display_name: 'Provider A', identity_version: 1, identity_status: 'active', identity_metadata_json: '{}',
		membership_id: 'membership-a', team_id: 'team-a', membership_status: 'approved', membership_metadata_json: '{}',
		membership_created_at: '2026-07-18T00:00:00.000Z', membership_updated_at: '2026-07-18T00:00:00.000Z',
	};
}

function store(diagnostics: ProjectCapacityDiagnostics, allocationSet: CapacityAllocationSetV2 | null) {
	const member = membershipRow();
	return {
		ensureInitialized: vi.fn(), run: vi.fn(), batch: vi.fn(),
		getProjectCapacityDiagnostics: vi.fn().mockResolvedValue(diagnostics),
		getActiveCapacityAllocationSet: vi.fn().mockResolvedValue(allocationSet),
		all: vi.fn(async (query: string) => {
			if (query.includes('FROM capacity_provider_team_memberships')) return [member];
			if (query.includes('FROM capacity_execution_providers')) return [];
			return [];
		}),
		first: vi.fn(async (query: string) => {
			if (query.includes('FROM capacity_provider_team_memberships')) return member;
			if (query.includes('COUNT(*) AS grant_count')) return { grant_count: 1, daily_credits: 10, monthly_credits: 100 };
			if (query.includes('FROM capacity_reservations')) return {
				active_reserved_credits: 2, daily_used_credits: 1, monthly_used_credits: 1,
				daily_terminal_credits: 1, monthly_terminal_credits: 1,
			};
			return null;
		}),
	};
}

function diagnostics(overrides: Partial<ProjectCapacityDiagnostics> = {}): ProjectCapacityDiagnostics {
	return {
		projectId: 'project-a', teamId: 'team-a', environment: 'local', executionProviders: [], activeReservations: [],
		providers: [{ providerId: 'provider-a', identityStatus: 'active', membershipStatus: 'approved' } as never],
		grants: [{ id: 'grant-a', status: 'active', dailyCreditLimit: 10, monthlyCreditLimit: 100, unmetered: false } as never],
		derivedCapacity: { entries: [] }, remaining: { dailyCredits: 8, monthlyCredits: 100 }, ...overrides,
	};
}

describe('capacity summary service', () => {
	it('uses canonical grant and membership status fields for project readiness and budget', async () => {
		const allocation = { id: 'allocation-a', status: 'active' } as CapacityAllocationSetV2;
		const result = await new CapacitySummaryService(store(diagnostics(), allocation)).project('project-a', 'local');
		expect(result).toMatchObject({
			projectId: 'project-a', environment: 'local', readiness: 'ready', reasons: [],
			dailyCredits: 10, dailyUsedCredits: 1, dailyReservedCredits: 3, dailyRemainingCredits: 7,
			activeProviderCount: 1,
		});
	});

	it('does not inherit a team limit for an explicitly unmetered project grant', async () => {
		const allocation = { id: 'allocation-a', status: 'active' } as CapacityAllocationSetV2;
		const result = await new CapacitySummaryService(store(diagnostics({
			grants: [{ id: 'grant-a', status: 'active', dailyCreditLimit: null, unmetered: true } as never],
		}), allocation)).project('project-a', 'local');
		expect(result).toMatchObject({ readiness: 'ready', dailyCredits: null, dailyRemainingCredits: null });
	});

	it('fails readiness when only a suspended membership remains', async () => {
		const allocation = { id: 'allocation-a', status: 'active' } as CapacityAllocationSetV2;
		const result = await new CapacitySummaryService(store(diagnostics({
			providers: [{ providerId: 'provider-a', identityStatus: 'active', membershipStatus: 'suspended' } as never],
		}), allocation)).project('project-a', 'local');
		expect(result).toMatchObject({ readiness: 'waiting_for_provider', reasons: ['no_active_provider'] });
	});
});
