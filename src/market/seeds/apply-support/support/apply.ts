import { applyAction, seedRunInput, createSeedRunIfAvailable, updateSeedRunIfAvailable, approvalMatchesPlan, createProductionApproval, redactSeedApplyResult, ensureLocalSeedTeamMemberships, planSeedWithStore, isoNow, createLocalSeedStore, manifestHashFor, selectedActions, mutationActions, actorType, ensureProjectSeedDependencies } from '../index.js';

export async function applySeedWithStore(input) {
    const planned = await planSeedWithStore({
        projectRoot: input.projectRoot,
        seedName: input.seedName,
        environments: input.environments,
        mode: 'apply',
        store: input.store,
        env: input.env,
        manifestRef: input.manifestRef,
        actor: input.actor,
    });
    if (!planned.plan) {
        throw new Error(planned.diagnostics?.[0]?.message ?? 'Seed plan failed.');
    }
    if (input.localOnly === true && planned.plan.environments.some((environment) => environment !== 'local')) {
        throw new Error('Local seed apply only supports the local environment.');
    }
    const store = input.store ?? await createLocalSeedStore(input.projectRoot, input.env);
    const manifestHash = planned['manifestHash'] ?? manifestHashFor(planned.manifestPath);
    let run = await createSeedRunIfAvailable(store, seedRunInput({
        plan: planned.plan,
        manifestHash,
        actor: input.actor,
    }));
    const hasProduction = planned.plan.environments.includes('prod');
    if (hasProduction) {
        const approval = input.approvalRequestId ? await store.getApprovalRequest(input.approvalRequestId) : null;
        if (!approvalMatchesPlan(approval, planned.plan, manifestHash)) {
            const approvalResult = input.approvalRequestId
                ? { ok: false, message: 'Production seed approval is missing, not approved, or does not match the current plan.' }
                : await createProductionApproval({ store, plan: planned.plan, manifestHash, actor: input.actor });
            const result = {
                blocked: true,
                reason: approvalResult.message ?? 'Production seed apply requires approval.',
                approvalRequest: approvalResult.approvalRequest ?? approval ?? null,
                actionCount: 0,
                manifestHash,
            };
            run = await updateSeedRunIfAvailable(store, run?.id, {
                state: 'blocked',
                result,
                error: { code: 'seed.production_approval_required', message: result.reason },
            }) ?? run;
            return {
                plan: planned.plan,
                result,
                run,
            };
        }
    }
    const appliedAt = isoNow();
    const ids = { teams: new Map(), repositoryHosts: new Map(), projects: new Map(), products: new Map(), productTeams: new Map() };
    const repairs = [];
    for (const action of selectedActions(planned.plan)) {
        if (action.existing?.id) {
            if (action.kind === 'team')
                ids.teams.set(action.key, action.existing.id);
            if (action.kind === 'repositoryHost')
                ids.repositoryHosts.set(action.key, action.existing.id);
            if (action.kind === 'project')
                ids.projects.set(action.key, action.existing.id);
            if (action.kind === 'product') {
                ids.products.set(action.key, action.existing.id);
                ids.productTeams.set(action.key, action.existing.teamId);
            }
        }
        await applyAction({ action, store, ids, manifestHash, appliedAt, plan: planned.plan });
        repairs.push(...await ensureProjectSeedDependencies({ action, store, ids, manifestHash, appliedAt }));
    }
    const localTeamMemberships = input.localOnly === true
        ? await ensureLocalSeedTeamMemberships({
            store,
            plan: planned.plan,
            ids,
            env: input.env,
            actor: input.actor,
        })
        : [];
    const result = {
        appliedAt,
        manifestHash,
        actionCount: mutationActions(planned.plan).length,
        repairs,
        localTeamMemberships,
    };
    run = await updateSeedRunIfAvailable(store, run?.id, {
        state: 'completed',
        result: redactSeedApplyResult(result),
    }) ?? run;
    return {
        plan: planned.plan,
        result,
        run,
    };
}

export async function applyLocalSeedFromCli(input) {
    return applySeedWithStore({
        ...input,
        localOnly: true,
        actor: input.actor ?? { actorType: 'local', id: 'cli' },
    });
}
