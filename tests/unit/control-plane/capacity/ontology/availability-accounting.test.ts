import { describe, expect, it } from 'vitest';
import { assertMonotonicAvailabilityAccounting } from '../../../../../src/api/capacity/services/accounts/availability-accounting.ts';
import { serializeAvailabilitySessionRow } from '../../../../../src/api/capacity/repositories/accounts/availability-session.ts';
import { canonicalOfferBuildInput } from '../execution/fixtures/assignment-attempt-fixtures.ts';
import { serializeCapacityExecutionProvider } from '../../../../../src/api/capacity/repositories/capacity/providers/execution-provider.ts';
import { deriveNativeCapacity, resolveNativeAccountingWindow } from '../../../../../src/api/capacity/services/capacity/accounting/native-capacity.ts';
import { serializeCapacityReservationRow } from '../../../../../src/api/capacity/repositories/capacity/accounting/reservation.ts';
const now = '2026-09-16T12:00:00.000Z';
const observation = { day: '2026-09-16', observedAt: now, healthy: true, activeSeconds: 100, reservedSeconds: 0 };
const adapter = { id: 'codex-implementation', adapter: 'codex', isolation: 'microvm', nativeLimits: { modelConfigurationId: 'terra-medium', dailyActiveSecondsLimit: 28800,
	capabilityLimits: { implementation: { dailyActiveSecondsLimit: 28800 } } }, accountingObservation: {
		modelUsage: observation, capabilityUsage: { implementation: observation } } };
describe('availability usage continuity', () => {
	it('debits only the exact canonical provider and execution identity while retaining shared and failed reservation history', () => {
		const nativeLimit = { id: 'limit', executionProviderId: 'execution', scope: 'daily', nativeUnit: 'token', limitAmount: 100,
			reserveBufferPercent: 10, confidence: 'high', source: 'configured', createdAt: now, updatedAt: now };
		const provider = serializeCapacityExecutionProvider({ id: 'execution', capacity_provider_id: 'provider', adapter: 'renamed-adapter',
			display_name: 'Supply', status: 'active', native_unit: 'token', quota_visibility: 'exact', max_concurrent_runners: 1,
			native_limits_json: JSON.stringify([nativeLimit]), capabilities_json: '[]', metadata_json: '{}', created_at: now, updated_at: now });
		const rows = [
			{ id: 'local', capacity_provider_id: 'provider', execution_provider_id: 'execution', state: 'reserved', reserved_native_amount: 3, consumed_native_amount: 0 },
			{ id: 'shared', capacity_provider_id: 'provider', execution_provider_id: null, state: 'reserved', reserved_native_amount: 2, consumed_native_amount: 0 },
			{ id: 'failed', capacity_provider_id: 'provider', execution_provider_id: 'execution', state: 'failed', reserved_native_amount: 4, consumed_native_amount: 4 },
			{ id: 'foreign', capacity_provider_id: 'foreign-provider', execution_provider_id: 'execution', state: 'reserved', reserved_native_amount: 70, consumed_native_amount: 0 },
			{ id: 'other-execution', capacity_provider_id: 'provider', execution_provider_id: 'other', state: 'reserved', reserved_native_amount: 50, consumed_native_amount: 0 },
		].map(row => ({ idempotency_key: row.id, membership_id: 'membership', project_agent_class_id: 'class', mode: 'acting',
			team_id: 'team', project_id: 'project', requested_seconds: 1, reserved_seconds: 1, active_seconds: 0, elapsed_seconds: 0,
			released_seconds: 0, overrun_seconds: 0, native_unit: 'token', policy_snapshot_json: '{}', metadata_json: '{}', created_at: now, updated_at: now, ...row }));
		const activeReservations = rows.map(row => serializeCapacityReservationRow(row)!);
		const input = { executionProvider: provider, nativeLimit, now, activeReservations }, held = structuredClone(input), raw = structuredClone(rows);
		const result = deriveNativeCapacity(input);
		expect(result).toMatchObject({ capacityProviderId: 'provider', executionProviderId: 'execution', activeReservedNativeAmount: 5,
			activeConsumedNativeAmount: 4, availableNativeAmount: 81 });
		expect(deriveNativeCapacity(input)).toEqual(result); expect(input).toEqual(held); expect(rows).toEqual(raw);
	});
	it('derives native budget identity from the canonical provider and adapter without rewriting native limits or observations', () => {
		for (const providerId of ['provider-one', 'renamed-provider']) for (const kind of ['configured-adapter', 'renamed-adapter']) {
			const nativeLimit = { id: 'daily-limit', executionProviderId: 'execution', scope: 'daily', nativeUnit: 'token',
				limitAmount: 100, reserveBufferPercent: 10, confidence: 'high', source: 'configured', createdAt: now, updatedAt: now };
			const provider = serializeCapacityExecutionProvider({ id: 'execution', capacity_provider_id: providerId,
				display_name: 'Configured supply', adapter: kind, status: 'active', capabilities_json: '[]', native_unit: 'token',
				quota_visibility: 'exact', max_concurrent_runners: 1, native_limits_json: JSON.stringify([nativeLimit]),
				metadata_json: '{}', created_at: now, updated_at: now });
			const input = { executionProvider: provider, nativeLimit, now, reservationDebits: { activeReservedNativeAmount: 3, activeConsumedNativeAmount: 4 } };
			const held = structuredClone(input), result = deriveNativeCapacity(input);
			expect(result).toMatchObject({ executionProviderId: 'execution', capacityProviderId: providerId, executionProviderKind: kind,
				nativeUnit: 'token', configuredNativeLimit: 100, activeReservedNativeAmount: 3, activeConsumedNativeAmount: 4,
				reserveBufferNativeAmount: 10, availableNativeAmount: 83, confidence: 'high' });
			expect(input).toEqual(held); expect(deriveNativeCapacity(input)).toEqual(result);
			const unknown = { ...input, nativeLimit: { ...nativeLimit, scope: 'session' } };
			expect(resolveNativeAccountingWindow(unknown)).toEqual({ startAt: null, endAt: null, source: 'unknown', known: false });
			expect(deriveNativeCapacity(unknown).availableNativeAmount).toBe(0);
		}
	});
	it('retains every canonical executable offer and exact runtime build in public availability readback without rewriting stored authority', () => {
		const provider = canonicalOfferBuildInput().providers[0]!;
		const row = { id: 'session', membership_id: 'membership', team_id: 'team', capacity_provider_id: 'provider',
			status: 'closed', sequence: 1, opened_at: now, refreshed_at: now, expires_at: now,
			execution_providers_json: JSON.stringify([{ ...adapter, runtimeBuild: provider.runtimeBuild, offers: provider.offers }]),
			capabilities_json: JSON.stringify(provider.capabilities), native_limits_json: '{}', runner_pressure_json: '{}', constraints_json: '{}' };
		const held = structuredClone(row), result = serializeAvailabilitySessionRow(row);
		expect(result?.snapshot.adapters[0]?.offers).toEqual(provider.offers);
		expect(result?.snapshot.adapters[0]?.runtimeBuild).toBe(provider.runtimeBuild);
		expect(result?.snapshot.adapters[0]?.accountingObservation).toEqual(adapter.accountingObservation);
		expect(row).toEqual(held); expect(serializeAvailabilitySessionRow(row)).toEqual(result);
	});
	it('denies malformed retained shared model and capability observations before renamed fresh or unhealthy publications can conceal prior authority', () => {
		const patches: Array<Record<string, unknown>> = [];
		for (const reservedSeconds of [undefined, null, '0', false, -1, NaN, Infinity, -Infinity]) patches.push({ reservedSeconds });
		for (const healthy of [undefined, null, 'true', 0, 1, [], {}]) patches.push({ healthy });
		for (const day of [undefined, null, '', 'not-a-day', '2026-02-30', '2026-09-15', 20260916]) patches.push({ day });
		for (const observedAt of [undefined, null, '', 'not-a-clock', 0]) patches.push({ observedAt });
		for (const patch of patches) for (const scope of ['model', 'capability']) for (const healthy of [true, false]) {
			const previous = structuredClone(adapter), current = structuredClone(adapter); current.id = 'renamed-current-publication';
			Object.assign(scope === 'model' ? previous.accountingObservation.modelUsage : previous.accountingObservation.capabilityUsage.implementation, patch);
			current.accountingObservation.modelUsage.healthy = healthy; current.accountingObservation.capabilityUsage.implementation.healthy = healthy;
			const before = structuredClone({ previous, current });
			expect(() => assertMonotonicAvailabilityAccounting([current], [previous], now)).toThrow('capability_accounting_invalid');
			expect({ previous, current }).toEqual(before);
		}
	});
	it('rejects nonboolean accounting health at both shared model and capability scopes without rewriting prior reports', () => {
		for (const scope of ['model', 'capability']) for (const healthy of [undefined, null, '', 'true', 'false', 0, 1, [], {}]) {
			const current = structuredClone(adapter);
			Object.assign(scope === 'model' ? current.accountingObservation.modelUsage : current.accountingObservation.capabilityUsage.implementation, { healthy });
			const before = structuredClone({ current, adapter });
			expect(() => assertMonotonicAvailabilityAccounting([current], [adapter], now)).toThrow('capability_accounting_invalid');
			expect({ current, adapter }).toEqual(before);
		}
	});
	it('compares every retained shared model report after adapter renaming without resetting usage or suppressing unhealthy regression', () => {
		const previous = [structuredClone(adapter), { ...structuredClone(adapter), id: 'renamed-prior', accountingObservation: {
			modelUsage: { ...observation, activeSeconds: 101 }, capabilityUsage: { implementation: { ...observation, activeSeconds: 101 } } } }];
		for (const healthy of [false, true]) {
			const current = { ...structuredClone(adapter), id: 'renamed-current', accountingObservation: {
				modelUsage: { ...observation, healthy }, capabilityUsage: { implementation: { ...observation, healthy } } } };
			const before = structuredClone({ previous, current });
			expect(() => assertMonotonicAvailabilityAccounting([current], previous, now)).toThrow('Provider usage cannot decrease');
			expect({ previous, current }).toEqual(before);
		}
		const current = { ...structuredClone(adapter), id: 'renamed-current', accountingObservation: {
			modelUsage: { ...observation, healthy: false, activeSeconds: 101 }, capabilityUsage: { implementation: { ...observation, healthy: false, activeSeconds: 101 } } } };
		const before = structuredClone({ previous, current });
		expect(() => assertMonotonicAvailabilityAccounting([current], previous, now)).not.toThrow(); expect({ previous, current }).toEqual(before);
	});
	it('retains canonical accounting observations in operator read-back', () => {
		const result = serializeAvailabilitySessionRow({ id: 'session', membership_id: 'membership', team_id: 'team', capacity_provider_id: 'provider',
			status: 'open', sequence: 1, opened_at: now, refreshed_at: now, expires_at: now,
			execution_providers_json: JSON.stringify([adapter]), capabilities_json: '[]', native_limits_json: '{}',
			runner_pressure_json: '{}', constraints_json: '{}' });
		expect(result?.snapshot.adapters[0]?.accountingObservation).toEqual(adapter.accountingObservation);
		expect(result?.snapshot.adapters[0]).toMatchObject({ adapter: 'codex', isolation: 'microvm' });
	});
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
