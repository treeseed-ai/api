import { actorId,actorType,isoNow } from '../index.js';
import type { ControlPlaneStore } from '../../../../api/persistence/store.ts';

export function seedRunInput({ plan, manifestHash, actor, state = 'running', result = undefined, error = undefined }: {
    plan: Record<string, unknown> & { seed: string; version: number; environments: readonly string[]; mode: string };
    manifestHash: string; actor?: Parameters<typeof actorId>[0] & Parameters<typeof actorType>[0];
    state?: string; result?: unknown; error?: unknown;
}) {
    return {
        seedName: plan.seed,
        seedVersion: plan.version,
        environments: plan.environments,
        mode: plan.mode,
        state,
        actorType: actorType(actor),
        actorId: actorId(actor),
        manifestHash,
        plan,
        result,
        error,
        completedAt: ['completed', 'blocked', 'failed', 'partial'].includes(state) ? isoNow() : null,
    };
}

export async function createSeedRunIfAvailable(store: Partial<Pick<ControlPlaneStore, 'createSeedRun'>>, input: Parameters<ControlPlaneStore['createSeedRun']>[0]) {
    if (typeof store.createSeedRun !== 'function')
        return null;
    return store.createSeedRun(input);
}

export async function updateSeedRunIfAvailable(store: Partial<Pick<ControlPlaneStore, 'updateSeedRun'>>, runId: string | null | undefined, input: Parameters<ControlPlaneStore['updateSeedRun']>[1]) {
    if (!runId || typeof store.updateSeedRun !== 'function')
        return null;
    return store.updateSeedRun(runId, input);
}
