import { resolve } from 'node:path';
import { loadAndPlanSeed } from '@treeseed/sdk/seeds';
import { reconcilePlanWithStore, seedRunInput, createSeedRunIfAvailable, createLocalSeedStore, manifestHashFor, mutationActions, manifestRefIsAllowed } from './index.js';

export async function planSeedWithStore(input) {
    if (!manifestRefIsAllowed(input.seedName, input.manifestRef)) {
        return {
            manifestPath: resolve(input.projectRoot, input.manifestRef ?? ''),
            diagnostics: [{
                    severity: 'error',
                    code: 'seed.unsupported_manifest_ref',
                    message: 'Seed manifestRef must match seeds/<name>.yaml.',
                    path: 'manifestRef',
                }],
            plan: null,
        };
    }
    const planned = loadAndPlanSeed({
        projectRoot: input.projectRoot,
        seedName: input.seedName,
        environments: input.environments,
        mode: input.mode ?? 'plan',
    });
    if (!planned.plan) {
        return planned;
    }
    const store = input.store ?? await createLocalSeedStore(input.projectRoot, input.env);
    const plan = await reconcilePlanWithStore(planned.plan, store);
    const manifestHash = manifestHashFor(planned.manifestPath);
    let run = null;
    if (input.audit === true) {
        run = await createSeedRunIfAvailable(store, seedRunInput({
            plan,
            manifestHash,
            actor: input.actor,
            state: 'completed',
            result: { actionCount: mutationActions(plan).length },
        }));
    }
    return {
        ...planned,
        plan,
        manifestHash,
        run,
    };
}

export async function planLocalSeedFromCli(input) {
    return planSeedWithStore(input);
}
