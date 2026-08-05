import type { CapacityReservation,NativeCapacityAvailability,NativeCapacityInput,NativeCapacitySummary } from '@treeseed/sdk';
import type {
CapacityExecutionProvider,
CapacityProviderMembershipView,
} from '@treeseed/sdk/capacity-provider/contracts';
import { deriveNativeCapacity,resolveNativeAccountingWindow } from '@treeseed/sdk/native-capacity';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { listCapacityExecutionProviders } from '../../../repositories/capacity/providers/execution-provider.ts';
import { CapacityProviderIdentityRepository } from '../../../repositories/capacity/providers/provider-identity.ts';
import { aggregateNativeReservationDebits } from '../accounting/native-reservation-aggregation-service.ts';

export interface NativeCapacityOptions {
	executionProviders?: CapacityExecutionProvider[];
	providers?: CapacityProviderMembershipView[];
	activeReservations?: CapacityReservation[];
	projectId?: string | null;
	now?: Date | string | null;
}

function eligible(provider: CapacityProviderMembershipView): boolean {
	return provider.identityStatus === 'active' && provider.membershipStatus === 'approved';
}

export function summarizeNativeCapacity(entries: NativeCapacityAvailability[]): NativeCapacitySummary {
	const availableNativeByUnit: Record<string, number> = {};
	for (const entry of entries) {
		availableNativeByUnit[entry.nativeUnit] = (availableNativeByUnit[entry.nativeUnit] ?? 0) + entry.availableNativeAmount;
	}
	return { entries, availableNativeByUnit };
}

export class NativeCapacityService {
	private readonly identities: CapacityProviderIdentityRepository;

	constructor(private readonly database: CapacityGovernanceDatabase) {
		this.identities = new CapacityProviderIdentityRepository(database);
	}

	async provider(teamId: string, providerId: string, options: NativeCapacityOptions = {}): Promise<NativeCapacitySummary> {
		await this.database.ensureInitialized();
		const membership = await this.identities.getTeamMembership(teamId, providerId);
		if (!membership || !eligible(membership)) return summarizeNativeCapacity([]);
		const executionProviders = options.executionProviders ?? await listCapacityExecutionProviders(this.database, providerId);
		const calculatedAt = options.now ?? new Date().toISOString();
		const entries: NativeCapacityAvailability[] = [];
		for (const executionProvider of executionProviders) {
			const limits = executionProvider.nativeLimits.length > 0
				? executionProvider.nativeLimits
				: [null];
			for (const limit of limits) {
				const nativeUnit = limit?.nativeUnit ?? executionProvider.nativeUnit;
				const accountingInput: NativeCapacityInput = {
					executionProvider, nativeLimit: limit, latestObservation: executionProvider.latestObservation ?? null,
					scope: limit?.scope ?? null, nativeUnit, now: calculatedAt,
				};
				const accountingWindow = resolveNativeAccountingWindow(accountingInput);
				const reservationDebits = options.activeReservations ? null : await aggregateNativeReservationDebits(this.database, {
					teamId, capacityProviderId: providerId, executionProviderId: executionProvider.id, nativeUnit,
					providerNativeUnit: executionProvider.nativeUnit, projectId: options.projectId ?? null,
					windowStartAt: accountingWindow.startAt, windowEndAt: accountingWindow.endAt,
				});
				entries.push(deriveNativeCapacity({
					...accountingInput, activeReservations: options.activeReservations, reservationDebits,
				}));
			}
		}
		return summarizeNativeCapacity(entries);
	}

	async team(teamId: string, options: NativeCapacityOptions = {}): Promise<NativeCapacitySummary> {
		await this.database.ensureInitialized();
		const providers = (options.providers ?? await this.identities.listTeamMemberships(teamId)).filter(eligible);
		const summaries = await Promise.all(providers.map(async (provider) => ({
			capacityProviderId: provider.providerId,
			...await this.provider(teamId, provider.providerId, {
				activeReservations: options.activeReservations?.filter((reservation) => reservation.capacityProviderId === provider.providerId),
				projectId: options.projectId, now: options.now,
			}),
		})));
		return { ...summarizeNativeCapacity(summaries.flatMap((summary) => summary.entries ?? [])), providers: summaries };
	}
}
