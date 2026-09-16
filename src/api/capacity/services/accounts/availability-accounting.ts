import { capabilityAccountingLimitsSchema, remainingCapabilitySeconds, type CapabilityAccountingObservation } from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError } from '../../database.ts';

type Adapter = Record<string, unknown>;
type Accounting = { modelUsage: CapabilityAccountingObservation; capabilityUsage: Record<string, CapabilityAccountingObservation> };

/** Compare the canonical availability snapshots; never reset usage on session renewal. */
export function assertMonotonicAvailabilityAccounting(adapters: Adapter[], previous: Adapter[], now: string) {
	for (const adapter of adapters) {
		if (!adapter.accountingObservation) continue; // Supply without accounting is ineligible at admission.
		const limits = capabilityAccountingLimitsSchema.parse(adapter.nativeLimits);
		const current = adapter.accountingObservation as Accounting;
		const prior = previous.filter(value => capabilityAccountingLimitsSchema.safeParse(value.nativeLimits).data?.modelConfigurationId === limits.modelConfigurationId);
		const check = (cap: number, observation: CapabilityAccountingObservation | undefined, before: CapabilityAccountingObservation | undefined) => {
			if (!observation) throw new CapacityGovernanceError('provider_accounting_missing', 'Accounting must cover the advertised model and capabilities.', 400);
			const remaining = remainingCapabilitySeconds({ now, maximumObservationAgeSeconds: 90, dailyLimitSeconds: cap,
				observation, previousObservation: before, ledgerActiveSeconds: 0, ledgerReservedSeconds: 0 });
			if (remaining.reason === 'non-monotonic') throw new CapacityGovernanceError('provider_accounting_regressed', 'Provider usage cannot decrease or move backward within its accounting scope.', 409);
		};
		check(limits.dailyActiveSecondsLimit, current.modelUsage, undefined);
		for (const value of prior) {
			const before = value.accountingObservation as Accounting | undefined;
			check(limits.dailyActiveSecondsLimit, current.modelUsage, before?.modelUsage);
			for (const [id, capability] of Object.entries(limits.capabilityLimits)) check(capability.dailyActiveSecondsLimit,
				current.capabilityUsage?.[id], before?.capabilityUsage?.[id]);
		}
		for (const [id, capability] of Object.entries(limits.capabilityLimits)) check(capability.dailyActiveSecondsLimit, current.capabilityUsage?.[id], undefined);
	}
}
