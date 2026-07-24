import type { CapacityAllocationSetV2, ProjectCapacityDiagnostics } from '@treeseed/sdk';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityProviderIdentityRepository } from '../../../repositories/capacity/providers/provider-identity.ts';
import { aggregateCapacityCreditReservations } from '../accounting/credit-reservation-aggregation-service.ts';
import { DerivedCapacityService } from '../capacity-core/derived-capacity-service.ts';
import type { ProjectCapacityEnvironment } from './project-capacity-diagnostics-service.ts';

interface CapacitySummaryStore extends CapacityGovernanceDatabase {
	getProjectCapacityDiagnostics(projectId: string, environment: ProjectCapacityEnvironment): Promise<ProjectCapacityDiagnostics | null>;
	getActiveCapacityAllocationSet(teamId: string): Promise<CapacityAllocationSetV2 | null>;
}

export interface TeamCapacitySummary {
	teamId: string;
	monthlyCredits: number | null;
	monthlyUsedCredits: number;
	monthlyReservedCredits: number;
	monthlyRemainingCredits: number | null;
	dailyCredits: number | null;
	dailyUsedCredits: number;
	dailyReservedCredits: number;
	dailyRemainingCredits: number | null;
	providerCount: number;
	activeProviderCount: number;
	degradedProviderCount: number;
	grantCount: number;
	derivedCapacity: Awaited<ReturnType<DerivedCapacityService['team']>>;
}

export interface ProjectCapacitySummary extends TeamCapacitySummary {
	projectId: string;
	environment: ProjectCapacityEnvironment;
	readiness: 'ready' | 'waiting_for_allocation' | 'waiting_for_provider' | 'waiting_for_budget';
	reasons: string[];
	allocationSet: CapacityAllocationSetV2 | null;
}

function total(values: Array<number | null | undefined>): number {
	return values.reduce<number>((sum, value) => sum + (Number.isFinite(value) ? Number(value) : 0), 0);
}

export class CapacitySummaryService {
	private readonly identities: CapacityProviderIdentityRepository;
	private readonly derived: DerivedCapacityService;

	constructor(private readonly store: CapacitySummaryStore) {
		this.identities = new CapacityProviderIdentityRepository(store);
		this.derived = new DerivedCapacityService(store);
	}

	async team(teamId: string, options: { now?: Date | string | null } = {}): Promise<TeamCapacitySummary> {
		await this.store.ensureInitialized();
		const [providers, grantTotals, reservationTotals] = await Promise.all([
			this.identities.listTeamMemberships(teamId),
			this.store.first(`SELECT COUNT(*) AS grant_count,
				COALESCE(SUM(daily_credit_limit), 0) AS daily_credits,
				COALESCE(SUM(monthly_credit_limit), 0) AS monthly_credits
				FROM capacity_grants WHERE team_id = ? AND status = 'active'`, [teamId]),
			aggregateCapacityCreditReservations(this.store, { teamId, now: options.now }),
		]);
		const dailyCredits = Number(grantTotals?.daily_credits ?? 0);
		const monthlyCredits = Number(grantTotals?.monthly_credits ?? 0);
		const dailyReservedCredits = reservationTotals.dailyCommittedCredits;
		const monthlyReservedCredits = reservationTotals.monthlyCommittedCredits;
		return {
			teamId,
			monthlyCredits: monthlyCredits || null,
			monthlyUsedCredits: reservationTotals.monthlyUsedCredits,
			monthlyReservedCredits,
			monthlyRemainingCredits: monthlyCredits ? Math.max(0, monthlyCredits - monthlyReservedCredits) : null,
			dailyCredits: dailyCredits || null,
			dailyUsedCredits: reservationTotals.dailyUsedCredits,
			dailyReservedCredits,
			dailyRemainingCredits: dailyCredits ? Math.max(0, dailyCredits - dailyReservedCredits) : null,
			providerCount: providers.length,
			activeProviderCount: providers.filter((provider) => provider.identityStatus === 'active' && provider.membershipStatus === 'approved').length,
			degradedProviderCount: providers.filter((provider) => provider.identityStatus !== 'active' || provider.membershipStatus !== 'approved').length,
			grantCount: Number(grantTotals?.grant_count ?? 0),
			derivedCapacity: await this.derived.team(teamId, { providers, now: options.now }),
		};
	}

	async project(projectId: string, environment: ProjectCapacityEnvironment = 'staging'): Promise<ProjectCapacitySummary | null> {
		await this.store.ensureInitialized();
		const diagnostics = await this.store.getProjectCapacityDiagnostics(projectId, environment);
		if (!diagnostics) return null;
		const [teamSummary, reservations, allocationSet] = await Promise.all([
			this.team(diagnostics.teamId),
			aggregateCapacityCreditReservations(this.store, { teamId: diagnostics.teamId, projectId }),
			this.store.getActiveCapacityAllocationSet(diagnostics.teamId),
		]);
		const dailyCredits = total(diagnostics.grants.filter((grant) => grant.status === 'active').map((grant) => grant.dailyCreditLimit));
		const hasUnmeteredGrant = diagnostics.grants.some((grant) => grant.status === 'active' && grant.unmetered === true);
		const eligibleProviders = diagnostics.providers.filter((provider) => provider.identityStatus === 'active' && provider.membershipStatus === 'approved');
		let readiness: ProjectCapacitySummary['readiness'] = 'ready';
		const reasons: string[] = [];
		if (!allocationSet) { readiness = 'waiting_for_allocation'; reasons.push('no_active_allocation_set'); }
		else if (eligibleProviders.length === 0) { readiness = 'waiting_for_provider'; reasons.push('no_active_provider'); }
		else if (!hasUnmeteredGrant && dailyCredits > 0 && Math.max(0, dailyCredits - reservations.dailyCommittedCredits) <= 0) {
			readiness = 'waiting_for_budget'; reasons.push('daily_budget_exhausted');
		}
		return {
			...teamSummary, projectId, environment,
			dailyCredits: hasUnmeteredGrant ? null : dailyCredits || null,
			dailyUsedCredits: reservations.dailyUsedCredits,
			dailyReservedCredits: reservations.dailyCommittedCredits,
			dailyRemainingCredits: hasUnmeteredGrant || dailyCredits === 0 ? null : Math.max(0, dailyCredits - reservations.dailyCommittedCredits),
			derivedCapacity: await this.derived.team(diagnostics.teamId, { providers: diagnostics.providers, projectId }),
			readiness, reasons, allocationSet,
		};
	}
}
