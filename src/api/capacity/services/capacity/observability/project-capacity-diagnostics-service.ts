import type {
	CapacityExecutionProvider,
	CapacityProviderMembershipView,
	CapacityReservation,
	DerivedCapacitySummary,
	ProjectCapacityDiagnostics,
	ProjectEnvironmentName,
} from '@treeseed/sdk';
import type { CapacityGrantV2 } from '@treeseed/sdk/agent-capacity/allocation';
import { MAX_CAPACITY_PAGE_LIMIT, type CapacityPage } from '@treeseed/sdk/capacity-pagination';
import { CapacityGovernanceError } from '../../../database.ts';
import type { CapacityCreditReservationTotals } from '../accounting/credit-reservation-aggregation-service.ts';

export type ProjectCapacityEnvironment = ProjectEnvironmentName | 'local';

interface CapacityProject {
	id: string;
	teamId: string;
}

export interface ProjectCapacityDiagnosticsStore {
	ensureInitialized(): Promise<void>;
	getProject(projectId: string): Promise<CapacityProject | null>;
	listCapacityGrantsPage(teamId: string, filters: { projectId: string; environment: ProjectCapacityEnvironment; status: 'active'; limit: number }): Promise<CapacityPage<CapacityGrantV2>>;
	getCapacityProvider(teamId: string, providerId: string): Promise<CapacityProviderMembershipView | null>;
	listProviderExecutionSnapshots(teamId: string, providerId: string): Promise<CapacityExecutionProvider[]>;
	listCapacityReservationsForProjectPage(
		projectId: string,
		filters: { states: Array<'reserved' | 'consuming'>; limit: number },
	): Promise<CapacityPage<CapacityReservation>>;
	getTeamDerivedCapacity(
		teamId: string,
		options: { providers: CapacityProviderMembershipView[]; projectId: string },
	): Promise<DerivedCapacitySummary>;
	getCapacityCreditReservationTotals(
		teamId: string,
		options: { projectId: string },
	): Promise<CapacityCreditReservationTotals>;
}

function finite(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function nestedMetric(metadata: Record<string, unknown>, key: string): number | null {
	return finite(metadata[key]) ?? finite(record(metadata.pressure)[key]);
}

function nestedFlag(metadata: Record<string, unknown>, key: string): boolean {
	const direct = metadata[key];
	const pressure = record(metadata.pressure)[key];
	return direct === true || direct === 'true' || pressure === true || pressure === 'true';
}

function reservationMetric(reservation: CapacityReservation, ...keys: string[]): number {
	const metadata = record(reservation.metadata);
	const estimate = record(metadata.attentionEstimate);
	for (const key of keys) {
		const value = finite(metadata[key]) ?? finite(estimate[key]);
		if (value !== null) return Math.max(0, value);
	}
	return 0;
}

export function deriveProviderPressure(
	provider: CapacityProviderMembershipView,
	executionProviders: CapacityExecutionProvider[],
	reservations: CapacityReservation[],
): Record<string, unknown> {
	const active = reservations.filter((reservation) =>
		reservation.capacityProviderId === provider.providerId
		&& ['reserved', 'consuming'].includes(reservation.state));
	const maxConcurrentRunners = executionProviders.reduce(
		(total, executionProvider) => total + Math.max(0, executionProvider.maxConcurrentRunners),
		0,
	);
	const maxActiveReservations = maxConcurrentRunners > 0 ? maxConcurrentRunners : null;
	const metadata = record(provider.identityMetadata);
	const nativeMetadata = executionProviders.map((entry) => record(entry.metadata));
	const activeAttentionLoad = active.reduce((total, reservation) => total + reservationMetric(
		reservation,
		'totalAttentionWeight',
		'attentionWeight',
	), 0);
	const activeContextTokens = active.reduce((total, reservation) => total + reservationMetric(
		reservation,
		'estimatedContextTokens',
		'contextTokens',
		'requiredContextTokens',
	), 0);
	const maxAttentionLoad = nativeMetadata.map((entry) => finite(entry.maxAttentionLoad)).find((value) => value !== null)
		?? finite(metadata.maxAttentionLoad);
	const maxContextTokens = nativeMetadata.map((entry) => finite(entry.maxContextTokens)).find((value) => value !== null)
		?? finite(metadata.maxContextTokens);
	return {
		activeReservations: active.length,
		maxActiveReservations,
		congestionRatio: maxActiveReservations ? active.length / maxActiveReservations : 0,
		quotaRemainingPercent: nestedMetric(metadata, 'quotaRemainingPercent'),
		sessionRemainingMinutes: nestedMetric(metadata, 'sessionRemainingMinutes'),
		subscriptionSaturationPercent: nestedMetric(metadata, 'subscriptionSaturationPercent'),
		providerUnavailable: nestedFlag(metadata, 'providerUnavailable'),
		activeAttentionLoad,
		maxAttentionLoad,
		attentionSaturationPercent: maxAttentionLoad ? (activeAttentionLoad / maxAttentionLoad) * 100 : null,
		activeContextTokens,
		maxContextTokens,
		contextSaturationPercent: maxContextTokens ? (activeContextTokens / maxContextTokens) * 100 : null,
		cooperative: {
			priceHint: finite(metadata.priceHint),
			latencyHint: finite(metadata.latencyHint),
			trustScore: finite(metadata.trustScore),
			availabilityScore: finite(metadata.availabilityScore),
			successProbability: finite(metadata.successProbability),
			spilloverEligible: metadata.spilloverEligible === true,
			utilityAcceptancePolicy: metadata.utilityAcceptancePolicy ?? null,
		},
	};
}

function sum(values: Array<number | null | undefined>): number {
	return values.reduce<number>((total, value) => total + (finite(value) ?? 0), 0);
}

export async function buildProjectCapacityDiagnostics(
	store: ProjectCapacityDiagnosticsStore,
	projectId: string,
	environment: ProjectCapacityEnvironment = 'staging',
): Promise<ProjectCapacityDiagnostics | null> {
	await store.ensureInitialized();
	const project = await store.getProject(projectId);
	if (!project) return null;
	const [grantPage, activeReservationPage, creditTotals] = await Promise.all([
		store.listCapacityGrantsPage(project.teamId, { projectId, environment, status: 'active', limit: MAX_CAPACITY_PAGE_LIMIT }),
		store.listCapacityReservationsForProjectPage(projectId, {
			states: ['reserved', 'consuming'],
			limit: MAX_CAPACITY_PAGE_LIMIT,
		}),
		store.getCapacityCreditReservationTotals(project.teamId, { projectId }),
	]);
	if (activeReservationPage.page.hasMore) {
		throw new CapacityGovernanceError(
			'capacity_project_diagnostics_active_reservation_bound_exceeded',
			`Project capacity diagnostics supports at most ${MAX_CAPACITY_PAGE_LIMIT} simultaneous active reservations; inspect the paginated reservation collection and recover stale reservations.`,
			409,
			{ projectId, limit: MAX_CAPACITY_PAGE_LIMIT, nextCursor: activeReservationPage.page.nextCursor },
		);
	}
	const activeReservations = activeReservationPage.items;
	if (grantPage.page.hasMore) {
		throw new CapacityGovernanceError(
			'capacity_project_diagnostics_grant_bound_exceeded',
			`Project capacity diagnostics supports at most ${MAX_CAPACITY_PAGE_LIMIT} active grants; inspect the paginated grant collection and remove overlapping or stale active policy.`,
			409,
			{ projectId, limit: MAX_CAPACITY_PAGE_LIMIT, nextCursor: grantPage.page.nextCursor },
		);
	}
	const grants = grantPage.items;
	const providerIds = new Set(grants.map((grant) => grant.providerId));
	const [providerResults, executionProviderGroups] = await Promise.all([
		Promise.all([...providerIds].map((providerId) => store.getCapacityProvider(project.teamId, providerId))),
		Promise.all([...providerIds].map((providerId) => store.listProviderExecutionSnapshots(project.teamId, providerId))),
	]);
	const executionProviders = executionProviderGroups.flat();
	const providers = providerResults
		.filter((provider): provider is CapacityProviderMembershipView => provider !== null)
		.map((provider) => ({
			...provider,
			identityMetadata: {
				...record(provider.identityMetadata),
				pressure: deriveProviderPressure(
					provider,
					executionProviders.filter((entry) => entry.providerId === provider.providerId),
					activeReservations,
				),
			},
		}));
	const dailyCredits = sum(grants.map((grant) => grant.dailyCreditLimit));
	const monthlyCredits = sum(grants.map((grant) => grant.monthlyCreditLimit));
	return {
		projectId,
		teamId: project.teamId,
		environment,
		providers,
		executionProviders,
		grants,
		activeReservations,
		derivedCapacity: await store.getTeamDerivedCapacity(project.teamId, { providers, projectId }),
		remaining: {
			dailyCredits: dailyCredits > 0 ? Math.max(0, dailyCredits - creditTotals.dailyCommittedCredits) : null,
			monthlyCredits: monthlyCredits || null,
		},
	};
}
