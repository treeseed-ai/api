import type {
	CapacityExecutionProvider,
	CapacityProviderMembershipView,
} from '@treeseed/sdk/capacity-provider/contracts';
import type { CapacityReservation, DerivedCapacityAvailability, DerivedCapacitySummary } from '@treeseed/sdk';
import { deriveAvailableCredits, resolveNativeAccountingWindow } from '@treeseed/sdk/capacity-usage';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CreditConversionProfileRepository } from '../repositories/credit-conversion-profile.ts';
import { listCapacityExecutionProviders } from '../repositories/execution-provider.ts';
import { CapacityProviderIdentityRepository } from '../repositories/provider-identity.ts';
import { aggregateNativeReservationDebits } from './native-reservation-aggregation-service.ts';

export interface DerivedCapacityOptions {
	executionProviders?: CapacityExecutionProvider[];
	providers?: CapacityProviderMembershipView[];
	activeReservations?: CapacityReservation[];
	projectId?: string | null;
	now?: Date | string | null;
}

function eligible(provider: CapacityProviderMembershipView): boolean {
	return provider.identityStatus === 'active' && provider.membershipStatus === 'approved';
}

export function summarizeDerivedCapacity(entries: DerivedCapacityAvailability[]): DerivedCapacitySummary {
	const availableNativeByUnit: Record<string, number> = {};
	let totalDerivedAvailableCredits = 0;
	let derivedEntryCount = 0;
	let learningEntryCount = 0;
	for (const entry of entries) {
		availableNativeByUnit[entry.nativeUnit] = (availableNativeByUnit[entry.nativeUnit] ?? 0) + entry.availableNativeAmount;
		if (entry.derivedAvailableCredits == null) learningEntryCount += 1;
		else {
			totalDerivedAvailableCredits += entry.derivedAvailableCredits;
			derivedEntryCount += 1;
		}
	}
	return {
		entries,
		totalDerivedAvailableCredits: Math.floor(totalDerivedAvailableCredits * 100) / 100,
		derivedEntryCount,
		learningEntryCount,
		availableNativeByUnit,
	};
}

export class DerivedCapacityService {
	private readonly identities: CapacityProviderIdentityRepository;
	private readonly profiles: CreditConversionProfileRepository;

	constructor(private readonly database: CapacityGovernanceDatabase) {
		this.identities = new CapacityProviderIdentityRepository(database);
		this.profiles = new CreditConversionProfileRepository(database);
	}

	async provider(teamId: string, providerId: string, options: DerivedCapacityOptions = {}): Promise<DerivedCapacitySummary> {
		await this.database.ensureInitialized();
		const membership = await this.identities.getTeamMembership(teamId, providerId);
		if (!membership || !eligible(membership)) return summarizeDerivedCapacity([]);
		const executionProviders = options.executionProviders ?? await listCapacityExecutionProviders(this.database, providerId);
		const calculatedAt = options.now ?? new Date().toISOString();
		const entries: DerivedCapacityAvailability[] = [];
		for (const executionProvider of executionProviders) {
			const limits = executionProvider.nativeLimits.length > 0
				? executionProvider.nativeLimits
				: [{ nativeUnit: executionProvider.nativeUnit, scope: null, limitAmount: null, reserveBufferPercent: 0 }];
			for (const limit of limits) {
				const nativeUnit = limit.nativeUnit ?? executionProvider.nativeUnit;
				const conversionProfile = await this.profiles.best(executionProvider.adapter, nativeUnit);
				const accountingInput = {
					executionProvider, nativeLimit: limit, latestObservation: executionProvider.latestObservation ?? null,
					scope: limit.scope ?? null, nativeUnit, now: calculatedAt,
				};
				const accountingWindow = resolveNativeAccountingWindow(accountingInput);
				const reservationDebits = options.activeReservations ? null : await aggregateNativeReservationDebits(this.database, {
					teamId, capacityProviderId: providerId, executionProviderId: executionProvider.id, nativeUnit,
					providerNativeUnit: executionProvider.nativeUnit, projectId: options.projectId ?? null,
					windowStartAt: accountingWindow.startAt, windowEndAt: accountingWindow.endAt,
				});
				entries.push(deriveAvailableCredits({
					...accountingInput, activeReservations: options.activeReservations, reservationDebits, conversionProfile,
				}));
			}
		}
		return summarizeDerivedCapacity(entries);
	}

	async team(teamId: string, options: DerivedCapacityOptions = {}): Promise<DerivedCapacitySummary> {
		await this.database.ensureInitialized();
		const providers = (options.providers ?? await this.identities.listTeamMemberships(teamId)).filter(eligible);
		const summaries = await Promise.all(providers.map(async (provider) => ({
			capacityProviderId: provider.providerId,
			...await this.provider(teamId, provider.providerId, {
				activeReservations: options.activeReservations?.filter((reservation) => reservation.capacityProviderId === provider.providerId),
				projectId: options.projectId, now: options.now,
			}),
		})));
		return { ...summarizeDerivedCapacity(summaries.flatMap((summary) => summary.entries ?? [])), providers: summaries };
	}
}
