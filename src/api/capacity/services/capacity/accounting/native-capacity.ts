import type { CapacityReservation } from '@treeseed/sdk/agent-capacity';
import type { NativeCapacityAvailability, NativeCapacityInput } from '../../../contracts.ts';
import type { CapacityExecutionProvider } from '@treeseed/sdk/capacity-provider/contracts';

export interface NativeAccountingWindow { startAt: string | null; endAt: string | null; source: 'observation' | 'configured_reset' | 'unknown'; known: boolean }

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function number(value: unknown): number | null { if (typeof value === 'number' && Number.isFinite(value)) return value; if (typeof value === 'string' && value.trim()) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; } return null; }
function firstNumber(...values: unknown[]): number | null { for (const value of values) { const parsed = number(value); if (parsed !== null) return parsed; } return null; }
function validDate(value: unknown): Date | null { if (value instanceof Date && Number.isFinite(value.getTime())) return value; if (typeof value !== 'string' || !value.trim()) return null; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed : null; }

function nativeUsageAmount(input: unknown, requestedUnit?: string | null): number | null {
	const native = record(input); const explicit = typeof native.nativeUnit === 'string' ? native.nativeUnit.trim() : typeof native.native_unit === 'string' ? native.native_unit.trim() : '';
	const unit = requestedUnit?.trim() || explicit || (firstNumber(native.wallMinutes, native.wall_minutes, native.durationMinutes, native.duration_minutes) !== null ? 'wall_minute' : firstNumber(native.quotaMinutes, native.quota_minutes) !== null ? 'quota_minute' : firstNumber(native.usd, native.costUsd, native.cost_usd) !== null ? 'usd' : firstNumber(native.inputTokens, native.input_tokens, native.outputTokens, native.output_tokens) !== null ? 'token' : null);
	if (unit === 'wall_minute') return firstNumber(native.wallMinutes, native.wall_minutes, native.durationMinutes, native.duration_minutes);
	if (unit === 'quota_minute') return firstNumber(native.quotaMinutes, native.quota_minutes); if (unit === 'usd') return firstNumber(native.usd, native.costUsd, native.cost_usd);
	if (unit === 'token') { const total = Math.max(0, (firstNumber(native.inputTokens, native.input_tokens) ?? 0) + (firstNumber(native.outputTokens, native.output_tokens) ?? 0) - (firstNumber(native.cachedInputTokens, native.cached_input_tokens) ?? 0)); return total > 0 ? total : null; }
	return unit ? firstNumber(native.amount, native.value, native.nativeAmount, native.native_amount) : null;
}

function reservationDebit(reservation: CapacityReservation, provider: CapacityExecutionProvider, nativeUnit: string) {
	if (!['reserved', 'consuming', 'consumed', 'failed', 'overran_pending_approval'].includes(reservation.state)) return { reserved: 0, consumed: 0 };
	const active = ['reserved', 'consuming'].includes(reservation.state); const terminal = ['consumed', 'failed', 'overran_pending_approval'].includes(reservation.state);
	if (reservation.nativeUnit === nativeUnit) return { reserved: active ? Math.max(reservation.reservedNativeAmount ?? 0, reservation.consumedNativeAmount ?? 0) : 0, consumed: terminal ? Math.max(reservation.consumedNativeAmount ?? 0, 0) : 0 };
	if (nativeUnit === 'usd') return { reserved: active ? Math.max(reservation.reservedUsd ?? 0, reservation.consumedUsd ?? 0) : 0, consumed: terminal ? Math.max(reservation.consumedUsd ?? 0, 0) : 0 };
	if (provider.nativeUnit === nativeUnit) return { reserved: active ? Math.max(reservation.reservedProviderUnits ?? 0, reservation.consumedProviderUnits ?? 0) : 0, consumed: terminal ? Math.max(reservation.consumedProviderUnits ?? 0, 0) : 0 };
	return { reserved: 0, consumed: 0 };
}

function configuredWindow(cadence: string, now: Date) {
	if (cadence === 'daily') { const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); return { start, end: new Date(start.getTime() + 86_400_000) }; }
	if (cadence === 'weekly') { const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)); return { start, end: new Date(start.getTime() + 604_800_000) }; }
	if (cadence === 'monthly') { const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); return { start, end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) }; }
	return null;
}

export function resolveNativeAccountingWindow(input: NativeCapacityInput, source?: 'observation' | 'configured_limit' | 'unknown'): NativeAccountingWindow {
	const resolvedSource = source ?? (nativeUsageAmount(input.latestObservation?.nativeRemaining, input.nativeUnit ?? input.nativeLimit?.nativeUnit) !== null ? 'observation' : number(input.nativeLimit?.limitAmount) !== null ? 'configured_limit' : 'unknown');
	if (resolvedSource === 'observation') { const observedAt = validDate(input.latestObservation?.observedAt); return observedAt ? { startAt: observedAt.toISOString(), endAt: validDate(input.latestObservation?.resetAt ?? input.nativeLimit?.resetAt)?.toISOString() ?? null, source: 'observation', known: true } : { startAt: null, endAt: null, source: 'unknown', known: false }; }
	if (resolvedSource !== 'configured_limit') return { startAt: null, endAt: null, source: 'unknown', known: false };
	const now = validDate(input.now) ?? new Date(); const metadata = record(input.nativeLimit?.metadata); const explicitStart = validDate(metadata.windowStartAt ?? metadata.window_start_at); const explicitEnd = validDate(input.nativeLimit?.resetAt ?? metadata.windowEndAt ?? metadata.window_end_at);
	if (explicitStart && explicitEnd && explicitStart < explicitEnd) return { startAt: explicitStart.toISOString(), endAt: explicitEnd.toISOString(), source: 'configured_reset', known: true };
	const cadence = String(input.nativeLimit?.resetCadence ?? input.executionProvider.resetCadence ?? input.nativeLimit?.scope ?? '').trim().toLowerCase(); const window = configuredWindow(cadence, now);
	return window ? { startAt: window.start.toISOString(), endAt: window.end.toISOString(), source: 'configured_reset', known: true } : { startAt: null, endAt: explicitEnd?.toISOString() ?? null, source: 'unknown', known: false };
}

export function deriveNativeCapacity(input: NativeCapacityInput): NativeCapacityAvailability {
	const provider = input.executionProvider; const nativeUnit = input.nativeUnit?.trim() || input.nativeLimit?.nativeUnit || provider.nativeUnit; const configured = number(input.nativeLimit?.limitAmount);
	const observed = nativeUsageAmount({ ...record(input.latestObservation?.nativeRemaining), nativeUnit }, nativeUnit); const source = observed !== null ? 'observation' : configured !== null ? 'configured_limit' : 'unknown'; const base = Math.max(0, observed ?? configured ?? 0);
	const window = resolveNativeAccountingWindow(input, source); const start = Date.parse(window.startAt ?? ''); const end = Date.parse(window.endAt ?? '');
	const debits = (input.activeReservations ?? []).filter((reservation) => reservation.executionProviderId ? reservation.executionProviderId === provider.id : reservation.capacityProviderId === provider.capacityProviderId).map((reservation) => { const debit = reservationDebit(reservation, provider, nativeUnit); const settled = Date.parse(reservation.updatedAt ?? reservation.createdAt ?? ''); return { ...debit, consumed: debit.consumed > 0 && window.known && Number.isFinite(settled) && settled >= start && (!Number.isFinite(end) || settled < end) ? debit.consumed : 0 }; });
	const activeReservedNativeAmount = input.reservationDebits?.activeReservedNativeAmount ?? debits.reduce((total, debit) => total + debit.reserved, 0); const activeConsumedNativeAmount = input.reservationDebits?.activeConsumedNativeAmount ?? debits.reduce((total, debit) => total + debit.consumed, 0);
	const reserveBufferPercent = Math.max(0, number(input.nativeLimit?.reserveBufferPercent) ?? 0); const reserveBufferNativeAmount = configured === null ? 0 : configured * reserveBufferPercent / 100; const availableNativeAmount = window.known ? Math.max(0, base - activeReservedNativeAmount - activeConsumedNativeAmount - reserveBufferNativeAmount) : 0;
	const reasons = [source === 'observation' ? 'observation_remaining' : source === 'configured_limit' ? 'configured_limit' : 'missing_native_limit']; if (activeReservedNativeAmount) reasons.push('active_native_reservations'); if (activeConsumedNativeAmount) reasons.push('native_usage_in_accounting_window'); if (!window.known) reasons.push('native_accounting_window_unknown'); if (reserveBufferNativeAmount) reasons.push('reserve_buffer');
	return { executionProviderId: provider.id, capacityProviderId: provider.capacityProviderId, executionProviderKind: provider.kind, nativeUnit, scope: input.scope ?? input.nativeLimit?.scope ?? null, configuredNativeLimit: configured, observedNativeRemaining: observed, nativeRemainingSource: source, activeReservedNativeAmount, activeConsumedNativeAmount, reserveBufferPercent, reserveBufferNativeAmount, availableNativeAmount, confidence: source === 'unknown' || !window.known ? 'low' : 'high', resetAt: input.latestObservation?.resetAt ?? input.nativeLimit?.resetAt ?? null, accountingWindowStartAt: window.startAt, accountingWindowEndAt: window.endAt, accountingWindowSource: window.source, reasons: [...new Set(reasons)], metadata: { quotaVisibility: provider.quotaVisibility, latestObservedAt: input.latestObservation?.observedAt ?? null } };
}
