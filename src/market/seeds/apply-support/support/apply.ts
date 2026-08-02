import { applyAction,approvalMatchesPlan,createLocalSeedStore,createProductionApproval,createSeedRunIfAvailable,ensureLocalSeedTeamMemberships,ensureProjectSeedDependencies,isoNow,manifestHashFor,mutationActions,planSeedWithStore,redactSeedApplyResult,seedRunInput,selectedActions,updateSeedRunIfAvailable } from '../index.js';

const PLATFORM_PROJECT_KEYS = ['market', 'admin', 'core', 'ui', 'sdk', 'api', 'cli', 'agent', 'treedx']
    .map((slug) => `project:treeseed/${slug}`);

async function verifyPlatformKnowledgeSeed(store, ids) {
    const teamId = ids.teams.get('team:treeseed');
    if (!teamId) throw new Error('TreeSeed knowledge seed postcondition failed: central team is absent.');
    const missing = PLATFORM_PROJECT_KEYS.filter((key) => !ids.projects.get(key));
    if (missing.length) throw new Error(`TreeSeed knowledge seed postcondition failed: missing projects ${missing.join(', ')}.`);
    for (const key of PLATFORM_PROJECT_KEYS) {
        const projectId = ids.projects.get(key);
        const [details, library] = await Promise.all([
            store.getProjectDetails(projectId), store.getProjectTreeDxLibrary(projectId),
        ]);
        if (!details || details.project.teamId !== teamId) throw new Error(`TreeSeed knowledge seed postcondition failed: ${key} has the wrong owner.`);
        const declaredMetadata = details.project.metadata?.metadata ?? details.project.metadata ?? {};
        if (declaredMetadata.visibility !== 'public') throw new Error(`TreeSeed knowledge seed postcondition failed: ${key} is not public.`);
        if (details.architecture?.contentRuntimeSource !== 'r2_published_manifest') {
            throw new Error(`TreeSeed knowledge seed postcondition failed: ${key} does not use the atomic published runtime.`);
        }
        if (!library?.repositoryId || !library?.contentRepositoryRef || !library?.contentPath) {
            throw new Error(`TreeSeed knowledge seed postcondition failed: ${key} lacks a complete TreeDX binding.`);
        }
    }
    const collection = await store.first(`SELECT team_id, book_ids_json FROM book_collections WHERE id = ? LIMIT 1`, ['treeseed-platform-library']);
    if (!collection || collection.team_id !== teamId) throw new Error('TreeSeed knowledge seed postcondition failed: managed platform library is absent.');
    return { teamId, projectCount: PLATFORM_PROJECT_KEYS.length, collectionId: 'treeseed-platform-library' };
}

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
    const ids = { teams: new Map(), projects: new Map(), products: new Map(), productTeams: new Map() };
    const repairs = [];
    const dependencyState = {};
    for (const action of selectedActions(planned.plan)) {
        if (action.existing?.id) {
            if (action.kind === 'team')
                ids.teams.set(action.key, action.existing.id);
            if (action.kind === 'project')
                ids.projects.set(action.key, action.existing.id);
            if (action.kind === 'product') {
                ids.products.set(action.key, action.existing.id);
                ids.productTeams.set(action.key, action.existing.teamId);
            }
        }
        await applyAction({ action, store, ids, manifestHash, appliedAt, plan: planned.plan });
        repairs.push(...await ensureProjectSeedDependencies({
            action, store, ids, manifestHash, appliedAt, env: input.env, localOnly: input.localOnly, dependencyState,
        }));
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
	const platformAdminOwnership = typeof store.syncPlatformAdminOwners === 'function'
		? await store.syncPlatformAdminOwners()
		: null;
    const platformKnowledge = await verifyPlatformKnowledgeSeed(store, ids);
    const result = {
        appliedAt,
        manifestHash,
        actionCount: mutationActions(planned.plan).length,
        repairs,
        localTeamMemberships,
		platformAdminOwnership,
		platformKnowledge,
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
