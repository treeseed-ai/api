import { addSeedReferencesToIds,applyAction,approvalMatchesPlan,createLocalSeedStore,createProductionApproval,createSeedRunIfAvailable,ensureLocalSeedTeamMemberships,ensureProjectSeedDependencies,isoNow,manifestHashFor,mutationActions,planSeedWithStore,redactSeedApplyResult,resolveSeedReferences,seedRunInput,selectedActions,updateSeedRunIfAvailable } from '../index.js';

async function verifyAppliedSeed(input, store) {
    const observed = await planSeedWithStore({
        projectRoot: input.projectRoot,
        seedName: input.seedName,
        environments: input.environments,
        mode: 'plan',
        store,
        env: input.env,
        manifestRef: input.manifestRef,
        actor: input.actor,
        bundle: input.bundle,
    });
    if (!observed.plan) throw new Error(observed.diagnostics?.[0]?.message ?? 'Seed read-back verification failed.');
    const drift = observed.plan.actions.filter((action) => ['create', 'update', 'delete', 'error'].includes(action.action));
    if (drift.length) {
        throw new Error(`Seed read-back verification found drift: ${drift.map((action) => `${action.action}:${action.key}`).join(', ')}.`);
    }
    return { verified: true, manifestHash: observed.manifestHash, summary: observed.plan.summary };
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
        bundle: input.bundle,
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
        plan: input.bundle ? { ...planned.plan, sourceBundle: input.bundle } : planned.plan,
        manifestHash,
        actor: input.actor,
    }));
    let activeActionKey = null;
    try {
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
    const ids = { teams: new Map(), projects: new Map(), projectTeams: new Map() };
	addSeedReferencesToIds(ids, await resolveSeedReferences(store, planned.plan.references ?? []));
    const repairs = [];
    const dependencyState = {};
	for (const action of selectedActions(planned.plan)) {
		activeActionKey = action.key;
        if (action.existing?.id) {
            if (action.kind === 'team')
                ids.teams.set(action.key, action.existing.id);
            if (action.kind === 'project') {
                ids.projects.set(action.key, action.existing.id);
				ids.projectTeams.set(action.key, ids.teams.get(action.payload.teamKey));
			}
        }
        await applyAction({ action, store, ids, manifestHash, appliedAt, plan: planned.plan });
		repairs.push(...await ensureProjectSeedDependencies({
            action, store, ids, manifestHash, appliedAt, env: input.env, localOnly: input.localOnly, dependencyState,
			plan: planned.plan,
		}));
	}
	activeActionKey = null;
	const membershipClaims = {
		declared: selectedActions(planned.plan).filter((action) => action.kind === 'teamMembership').map((action) => action.key),
		removed: await store.retireUndeclaredSeedTeamMembershipClaims(
			planned.plan.seed,
			selectedActions(planned.plan).filter((action) => action.kind === 'teamMembership').map((action) => action.key),
		),
	};
	const servicePrincipalMemberships = {
		declared: selectedActions(planned.plan).filter((action) => action.kind === 'servicePrincipalMembership').map((action) => action.key),
		removed: await store.retireUndeclaredSeedServicePrincipalMemberships(
			planned.plan.seed,
			selectedActions(planned.plan).filter((action) => action.kind === 'servicePrincipalMembership').map((action) => action.key),
		),
	};
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
    const verification = await verifyAppliedSeed(input, store);
    const result = {
        appliedAt,
        manifestHash,
        actionCount: mutationActions(planned.plan).length,
		repairs,
		membershipClaims,
		servicePrincipalMemberships,
        localTeamMemberships,
		platformAdminOwnership,
		verification,
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
    } catch (error) {
        const message = activeActionKey
            ? `Seed application failed while reconciling ${activeActionKey}.`
            : 'Seed application failed during authoritative read-back.';
        run = await updateSeedRunIfAvailable(store, run?.id, {
            state: 'failed',
            error: { code: 'seed_apply_failed', message, actionKey: activeActionKey },
        }) ?? run;
        throw error;
    }
}

export async function applyLocalSeedFromCli(input) {
    return applySeedWithStore({
        ...input,
        localOnly: true,
        actor: input.actor ?? { actorType: 'local', id: 'cli' },
    });
}
