import { compact, safeArray } from '../operations/operational-artifacts.js';
import { workdayRef, numberValue, numberOrNull } from './index.js';

export function capacityProjection(bundle: any) {
    const ledgerEntries = safeArray(bundle.ledgerEntries);
    const reservations = safeArray(bundle.reservations).filter((reservation: any) => !workdayRef(reservation) || workdayRef(reservation) === bundle.workday.id);
    const usageActuals = safeArray(bundle.usageActuals);
    const derivedEntries = safeArray(bundle.capacitySummary?.derivedCapacity?.entries ?? bundle.capacityOperations?.diagnostics?.derivedCapacity?.entries);
    const nativeUsage = usageActuals.map((actual: any) => ({
        id: compact(actual?.id, compact(actual?.taskId, 'usage')),
        taskId: compact(actual?.taskId ?? actual?.task_id, ''),
        nativeUnit: compact(actual?.nativeUsage?.nativeUnit ?? actual?.native_usage?.nativeUnit ?? actual?.nativeUnit, ''),
        amount: numberOrNull(actual?.nativeUsage?.amount ?? actual?.nativeUsage?.nativeAmount ?? actual?.nativeUsage?.usd ?? actual?.nativeUsage?.wallMinutes ?? actual?.nativeUsage?.quotaMinutes),
        actualCredits: numberOrNull(actual?.actualCredits ?? actual?.actual_credits),
        source: compact(actual?.actualCreditsSource ?? actual?.actual_credits_source ?? actual?.source, ''),
    }));
    return {
        summary: bundle.capacitySummary ?? null,
        ledgerEntries,
        reservations,
        usageActuals,
        nativeUsage,
        derivedEntries,
        totalCredits: ledgerEntries.reduce((sum: number, entry: any) => sum + numberValue(entry?.credits, 0), 0),
        totalUsd: ledgerEntries.reduce((sum: number, entry: any) => sum + numberValue(entry?.usd, 0), 0),
        totalReservedNative: reservations.reduce((sum: number, reservation: any) => sum + numberValue(reservation?.reservedNativeAmount, 0), 0),
        totalConsumedNative: reservations.reduce((sum: number, reservation: any) => sum + numberValue(reservation?.consumedNativeAmount, 0), 0),
    };
}
