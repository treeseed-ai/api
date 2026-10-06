import { addSeedReferencesToIds,applyAction,approvalMatchesPlan,createLocalSeedStore,createProductionApproval,createSeedRunIfAvailable,ensureLocalSeedTeamMemberships,ensureProjectSeedDependencies,isoNow,manifestHashFor,mutationActions,planSeedWithStore,redactSeedApplyResult,resolveSeedReferences,seedRunInput,selectedActions,updateSeedRunIfAvailable } from '../index.js';

type ApplySeedInput = Parameters<typeof planSeedWithStore>[0] & { localOnly?: boolean; approvalRequestId?: string };

async function verifyAppliedSeed(input: ApplySeedInput, store: Parameters<typeof applyAction>[0]['store']) {
    const observed = await planSeedWithStore({ ...input, mode: 'plan', store });
    if (!observed.plan) throw new Error(observed.diagnostics?.[0]?.message ?? 'Seed read-back verification failed.');
    const drift = observed.plan.actions.filter((action) => ['create', 'update', 'delete', 'error'].includes(action.action));
    if (drift.length) {
        throw new Error(`Seed read-back verification found drift: ${drift.map((action) => `${action.action}:${action.key}`).join(', ')}.`);
    }
    return { verified: true, manifestHash: 'manifestHash' in observed ? observed.manifestHash : undefined, summary: observed.plan.summary };
}

export async function applyPlannedSeedActions(input: Omit<Parameters<typeof ensureProjectSeedDependencies>[0], 'action'> & {
    actor?: ApplySeedInput['actor']; setActiveActionKey?: (key: string) => void;
    plan: Parameters<typeof ensureProjectSeedDependencies>[0]['plan'] & { environments: string[] };
}, dependencies: Partial<{
    applyAction: typeof applyAction;
    ensureProjectSeedDependencies: typeof ensureProjectSeedDependencies;
    ensureLocalSeedTeamMemberships: typeof ensureLocalSeedTeamMemberships;
}> = {}) {
    const apply = dependencies.applyAction ?? applyAction;
    const ensureDependencies = dependencies.ensureProjectSeedDependencies ?? ensureProjectSeedDependencies;
    const ensureMemberships = dependencies.ensureLocalSeedTeamMemberships ?? ensureLocalSeedTeamMemberships;
    const repairs = [];
    const localTeamMemberships = [];
    for (const action of selectedActions(input.plan)) {
        input.setActiveActionKey?.(action.key);
        if (action.existing?.id) {
            if (action.kind === 'team')
                input.ids.teams.set(action.key, action.existing.id);
            if (action.kind === 'project') {
                input.ids.projects.set(action.key, action.existing.id);
                input.ids.projectTeams.set(action.key, input.ids.teams.get(action.payload.teamKey));
            }
        }
        await apply({ action, store: input.store, ids: input.ids, manifestHash: input.manifestHash, appliedAt: input.appliedAt, plan: input.plan });
        // A project create is authorized through its team. Local seed actors must
        // therefore receive ownership as soon as each team is reconciled, not
        // after every dependent project and repository action has run.
        if (input.localOnly === true && action.kind === 'team') {
            localTeamMemberships.push(...await ensureMemberships({
                store: input.store,
                plan: input.plan,
                ids: input.ids,
                env: input.env,
                actor: input.actor,
            }));
        }
        repairs.push(...await ensureDependencies({
            action, store: input.store, ids: input.ids, manifestHash: input.manifestHash,
            appliedAt: input.appliedAt, env: input.env, localOnly: input.localOnly,
            dependencyState: input.dependencyState, plan: input.plan,
        }));
    }
    return { repairs, localTeamMemberships };
}

export async function applySeedWithStore(input: ApplySeedInput) {
    const planned = await planSeedWithStore({ ...input, mode: 'apply' });
    if (!planned.plan) {
        throw new Error(planned.diagnostics?.[0]?.message ?? 'Seed plan failed.');
    }
    if (input.localOnly === true && planned.plan.environments.some((environment) => environment !== 'local')) {
        throw new Error('Local seed apply only supports the local environment.');
    }
    const store = input.store ?? await createLocalSeedStore(input.projectRoot, input.env);
    const manifestHash = ('manifestHash' in planned ? planned.manifestHash : undefined) ?? manifestHashFor(planned.manifestPath);
    let run = await createSeedRunIfAvailable(store, seedRunInput({
        plan: input.bundle ? { ...planned.plan, sourceBundle: input.bundle } : planned.plan,
        manifestHash,
        actor: input.actor,
    }));
    let activeActionKey: string | null = null;
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
                approvalRequest: ('approvalRequest' in approvalResult ? approvalResult.approvalRequest : undefined) ?? approval ?? null,
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
    const dependencyState = {};
	const { repairs, localTeamMemberships } = await applyPlannedSeedActions({
		plan: planned.plan, store, ids, manifestHash, appliedAt, env: input.env,
		localOnly: input.localOnly, actor: input.actor, dependencyState,
		setActiveActionKey(value) { activeActionKey = value; },
	});
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
		const causeMessage = error instanceof Error && error.message.trim() ? error.message.trim() : 'Unknown reconciliation failure.';
		const causeCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
        const message = activeActionKey
            ? `Seed application failed while reconciling ${activeActionKey}.`
            : 'Seed application failed during authoritative read-back.';
        run = await updateSeedRunIfAvailable(store, run?.id, {
            state: 'failed',
            error: { code: 'seed_apply_failed', message, actionKey: activeActionKey, causeCode, causeMessage },
        }) ?? run;
        throw error;
    }
}

export async function applyLocalSeedFromCli(input: ApplySeedInput) {
    return applySeedWithStore({
        ...input,
        localOnly: true,
        actor: input.actor ?? { actorType: 'local', id: 'cli' },
    });
}
