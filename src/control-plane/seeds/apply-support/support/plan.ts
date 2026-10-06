import { resolve } from 'node:path';
import { loadAndPlanCoreSeed } from '../../planning/load-core-seed-plan.ts';
import { planPortableSeedBundle } from '../../planning/plan-portable-seed-bundle.ts';
import { createLocalSeedStore,createSeedRunIfAvailable,manifestHashFor,manifestRefIsAllowed,mutationActions,reconcilePlanWithStore,seedRunInput } from '../index.js';
import type { ControlPlaneStore } from '../../../../api/persistence/store.ts';
import type { OperationInvocationContext } from '../../../../api/control-plane/catalog/operation-registry.ts';

type SeedPlanInput = Pick<Parameters<typeof planPortableSeedBundle>[0], 'seedName' | 'environments'> & {
    mode?: 'plan' | 'apply'; store?: ControlPlaneStore; env?: NodeJS.ProcessEnv;
    manifestRef?: string; audit?: boolean; actor?: Parameters<typeof seedRunInput>[0]['actor'] & { principal?: OperationInvocationContext['principal'] };
} & ({ bundle: Parameters<typeof planPortableSeedBundle>[0]['bundle']; projectRoot?: string }
    | { bundle?: undefined; projectRoot: string });

export async function planSeedWithStore(input: SeedPlanInput) {
    if (input.bundle) {
        const planned = await planPortableSeedBundle({
            bundle: input.bundle,
            seedName: input.seedName,
            environments: input.environments,
            mode: input.mode ?? 'plan',
        });
        if (!planned.plan) return planned;
        const store = input.store ?? await createLocalSeedStore(input.projectRoot, input.env);
        const plan = await reconcilePlanWithStore(planned.plan, store);
        let run = null;
        if (input.audit === true) run = await createSeedRunIfAvailable(store, seedRunInput({
            plan, manifestHash: planned.manifestHash, actor: input.actor,
            state: 'completed', result: { actionCount: mutationActions(plan).length },
        }));
        return { ...planned, plan, run };
    }
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
    const planned = loadAndPlanCoreSeed({
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

export async function planLocalSeedFromCli(input: SeedPlanInput) {
    return planSeedWithStore(input);
}
