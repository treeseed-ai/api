import { describe, expect, it } from 'vitest';
import { assertMonotonicAvailabilityAccounting } from '../../../../../src/api/capacity/services/accounts/availability-accounting.ts';
const now = '2026-09-16T12:00:00.000Z';
const observation = { day: '2026-09-16', observedAt: now, healthy: true, activeSeconds: 100, reservedSeconds: 0 };
const adapter = { id: 'codex-implementation', nativeLimits: { modelConfigurationId: 'terra-medium', dailyActiveSecondsLimit: 28800,
	capabilityLimits: { implementation: { dailyActiveSecondsLimit: 28800 } } }, accountingObservation: {
		modelUsage: observation, capabilityUsage: { implementation: observation } } };
describe('availability usage continuity', () => {
	it('rejects decreasing model usage even if the report is unhealthy or the adapter ID changes', () => {
		const current = { ...adapter, id: 'another-terra', accountingObservation: { ...adapter.accountingObservation,
			modelUsage: { ...observation, healthy: false, activeSeconds: 99 } } };
		expect(() => assertMonotonicAvailabilityAccounting([current], [adapter], now)).toThrow('Provider usage cannot decrease');
	});
	it('rejects decreasing capability usage and incomplete attribution', () => {
		const current = { ...adapter, accountingObservation: { modelUsage: observation,
			capabilityUsage: { implementation: { ...observation, activeSeconds: 99 } } } };
		expect(() => assertMonotonicAvailabilityAccounting([current], [adapter], now)).toThrow('Provider usage cannot decrease');
		expect(() => assertMonotonicAvailabilityAccounting([{ ...adapter, accountingObservation: { modelUsage: observation, capabilityUsage: {} } }], [], now)).toThrow('Accounting must cover');
	});
	it('permits daily rollover but not a report moving backward in time', () => {
		const next = { ...observation, day: '2026-09-17', observedAt: '2026-09-17T00:00:01.000Z', activeSeconds: 0 };
		const current = { ...adapter, accountingObservation: { modelUsage: next, capabilityUsage: { implementation: next } } };
		expect(() => assertMonotonicAvailabilityAccounting([current], [adapter], next.observedAt)).not.toThrow();
		expect(() => assertMonotonicAvailabilityAccounting([adapter], [current], now)).toThrow('Provider usage cannot decrease');
	});
});
