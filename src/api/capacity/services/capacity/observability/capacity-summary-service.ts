import type { CapacityAllocationSetV2 } from '@treeseed/sdk/agent-capacity';
import type { ProjectCapacityDiagnostics } from '../../../contracts.ts';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityProviderIdentityRepository } from '../../../repositories/capacity/providers/provider-identity.ts';
import { aggregateCapacityTimeReservations } from '../accounting/agent-time-reservation-aggregation-service.ts';
import { NativeCapacityService } from '../capacity-core/native-capacity-service.ts';
import type { ProjectCapacityEnvironment } from './project-capacity-diagnostics-service.ts';

interface CapacitySummaryStore extends CapacityGovernanceDatabase {
	getProjectCapacityDiagnostics(projectId: string, environment: ProjectCapacityEnvironment): Promise<ProjectCapacityDiagnostics | null>;
	getActiveCapacityAllocationSet(teamId: string): Promise<CapacityAllocationSetV2 | null>;
}

export interface TeamCapacitySummary {
	teamId: string;
	monthlyAgentSeconds: number | null;
	monthlyActiveSeconds: number;
	monthlyReservedSeconds: number;
	monthlyRemainingSeconds: number | null;
	dailyAgentSeconds: number | null;
	dailyActiveSeconds: number;
	dailyReservedSeconds: number;
	dailyRemainingSeconds: number | null;
	providerCount: number;
	activeProviderCount: number;
	degradedProviderCount: number;
	grantCount: number;
	nativeCapacity: Awaited<ReturnType<NativeCapacityService['team']>>;
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
	private readonly native: NativeCapacityService;

	constructor(private readonly store: CapacitySummaryStore) {
		this.identities = new CapacityProviderIdentityRepository(store);
		this.native = new NativeCapacityService(store);
	}

	async team(teamId: string, options: { now?: Date | string | null } = {}): Promise<TeamCapacitySummary> {
		await this.store.ensureInitialized();
		const [providers, grantTotals, reservationTotals] = await Promise.all([
			this.identities.listTeamMemberships(teamId),
			this.store.first(`SELECT COUNT(*) AS grant_count,
				COALESCE(SUM(daily_agent_seconds_limit), 0) AS daily_agent_seconds,
				COALESCE(SUM(monthly_agent_seconds_limit), 0) AS monthly_agent_seconds
				FROM capacity_grants WHERE team_id = ? AND status = 'active'`, [teamId]),
			aggregateCapacityTimeReservations(this.store, { teamId, now: options.now }),
		]);
		const dailyAgentSeconds = Number(grantTotals?.daily_agent_seconds ?? 0);
		const monthlyAgentSeconds = Number(grantTotals?.monthly_agent_seconds ?? 0);
		const dailyReservedSeconds = reservationTotals.dailyCommittedSeconds;
		const monthlyReservedSeconds = reservationTotals.monthlyCommittedSeconds;
		return {
			teamId,
			monthlyAgentSeconds: monthlyAgentSeconds || null,
			monthlyActiveSeconds: reservationTotals.monthlyActiveSeconds,
			monthlyReservedSeconds,
			monthlyRemainingSeconds: monthlyAgentSeconds ? Math.max(0, monthlyAgentSeconds - monthlyReservedSeconds) : null,
			dailyAgentSeconds: dailyAgentSeconds || null,
			dailyActiveSeconds: reservationTotals.dailyActiveSeconds,
			dailyReservedSeconds,
			dailyRemainingSeconds: dailyAgentSeconds ? Math.max(0, dailyAgentSeconds - dailyReservedSeconds) : null,
			providerCount: providers.length,
			activeProviderCount: providers.filter((provider) => provider.identityStatus === 'active' && provider.membershipStatus === 'approved').length,
			degradedProviderCount: providers.filter((provider) => provider.identityStatus !== 'active' || provider.membershipStatus !== 'approved').length,
			grantCount: Number(grantTotals?.grant_count ?? 0),
			nativeCapacity: await this.native.team(teamId, { providers, now: options.now }),
		};
	}

	async project(projectId: string, environment: ProjectCapacityEnvironment = 'staging'): Promise<ProjectCapacitySummary | null> {
		await this.store.ensureInitialized();
		const diagnostics = await this.store.getProjectCapacityDiagnostics(projectId, environment);
		if (!diagnostics) return null;
		const [teamSummary, reservations, allocationSet] = await Promise.all([
			this.team(diagnostics.teamId),
			aggregateCapacityTimeReservations(this.store, { teamId: diagnostics.teamId, projectId }),
			this.store.getActiveCapacityAllocationSet(diagnostics.teamId),
		]);
		const dailyAgentSeconds = total(diagnostics.grants.filter((grant) => grant.status === 'active').map((grant) => grant.dailyAgentSecondsLimit));
		const hasUnmeteredGrant = diagnostics.grants.some((grant) => grant.status === 'active' && grant.unmetered === true);
		const eligibleProviders = diagnostics.providers.filter((provider) => provider.identityStatus === 'active' && provider.membershipStatus === 'approved');
		let readiness: ProjectCapacitySummary['readiness'] = 'ready';
		const reasons: string[] = [];
		if (!allocationSet) { readiness = 'waiting_for_allocation'; reasons.push('no_active_allocation_set'); }
		else if (eligibleProviders.length === 0) { readiness = 'waiting_for_provider'; reasons.push('no_active_provider'); }
		else if (!hasUnmeteredGrant && dailyAgentSeconds > 0 && Math.max(0, dailyAgentSeconds - reservations.dailyCommittedSeconds) <= 0) {
			readiness = 'waiting_for_budget'; reasons.push('daily_budget_exhausted');
		}
		return {
			...teamSummary, projectId, environment,
			dailyAgentSeconds: hasUnmeteredGrant ? null : dailyAgentSeconds || null,
			dailyActiveSeconds: reservations.dailyActiveSeconds,
			dailyReservedSeconds: reservations.dailyCommittedSeconds,
			dailyRemainingSeconds: hasUnmeteredGrant || dailyAgentSeconds === 0 ? null : Math.max(0, dailyAgentSeconds - reservations.dailyCommittedSeconds),
			nativeCapacity: await this.native.team(diagnostics.teamId, { providers: diagnostics.providers, projectId }),
			readiness, reasons, allocationSet,
		};
	}
}
