import { compact,safeArray } from '../operations/operational-artifacts.js';
import { numberOrNull,numberValue,workdayRef } from './index.js';

export function capacityProjection(bundle: any) {
    const ledgerEntries = safeArray(bundle.ledgerEntries);
    const reservations = safeArray(bundle.reservations).filter((reservation: any) => !workdayRef(reservation) || workdayRef(reservation) === bundle.workday.id);
    const usageActuals = safeArray(bundle.usageActuals);
	const nativeCapacityEntries = safeArray(bundle.capacitySummary?.nativeCapacity?.entries ?? bundle.capacityOperations?.diagnostics?.nativeCapacity?.entries);
	const nativeUsage = usageActuals.map((actual: any) => ({
        id: compact(actual?.id, compact(actual?.taskId, 'usage')),
        taskId: compact(actual?.taskId ?? actual?.task_id, ''),
        nativeUnit: compact(actual?.nativeUsage?.nativeUnit ?? actual?.native_usage?.nativeUnit ?? actual?.nativeUnit, ''),
        amount: numberOrNull(actual?.nativeUsage?.amount ?? actual?.nativeUsage?.nativeAmount ?? actual?.nativeUsage?.usd ?? actual?.nativeUsage?.wallMinutes ?? actual?.nativeUsage?.quotaMinutes),
		activeSeconds: numberOrNull(actual?.activeSeconds ?? actual?.active_seconds),
		elapsedSeconds: numberOrNull(actual?.elapsedSeconds ?? actual?.elapsed_seconds),
		source: compact(actual?.source ?? actual?.nativeUsage?.source ?? actual?.native_usage?.source, ''),
    }));
    return {
        summary: bundle.capacitySummary ?? null,
        ledgerEntries,
        reservations,
        usageActuals,
        nativeUsage,
		nativeCapacityEntries,
		totalActiveSeconds: ledgerEntries.reduce((sum: number, entry: any) => sum + numberValue(entry?.activeSeconds ?? entry?.active_seconds, 0), 0),
		totalElapsedSeconds: ledgerEntries.reduce((sum: number, entry: any) => sum + numberValue(entry?.elapsedSeconds ?? entry?.elapsed_seconds, 0), 0),
        totalUsd: ledgerEntries.reduce((sum: number, entry: any) => sum + numberValue(entry?.usd, 0), 0),
        totalReservedNative: reservations.reduce((sum: number, reservation: any) => sum + numberValue(reservation?.reservedNativeAmount, 0), 0),
        totalConsumedNative: reservations.reduce((sum: number, reservation: any) => sum + numberValue(reservation?.consumedNativeAmount, 0), 0),
    };
}
