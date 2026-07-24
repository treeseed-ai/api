import { isoNow, actorId, actorType } from '../index.js';

export function seedRunInput({ plan, manifestHash, actor, state = 'running', result = undefined, error = undefined }) {
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

export async function createSeedRunIfAvailable(store, input) {
    if (typeof store.createSeedRun !== 'function')
        return null;
    return store.createSeedRun(input);
}

export async function updateSeedRunIfAvailable(store, runId, input) {
    if (!runId || typeof store.updateSeedRun !== 'function')
        return null;
    return store.updateSeedRun(runId, input);
}
