import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveApiDatabaseUrl } from '@treeseed/sdk/api';
import { loadAndPlanSeed } from '@treeseed/sdk/seeds';
import YAML from 'yaml';
import { createMarketPostgresDatabase } from '../../../api/market-postgres.js';
import { MarketControlPlaneStore } from '../../../api/store.js';
import { isoNow, stableJson, stripSeedRuntimeMetadata, comparablePayload, actionIsUnchanged, mergeSeedMetadata, resolveLocalSeedEnv, createLocalSeedStore, manifestHashFor, slugKey, generatedKey, seededKey, exportMetadata, maybeAssign, pruneNullish, sortBy, normalizeExportEnvironments, selectedActions, mutationActions, actorId, actorType, manifestRefIsAllowed, emptyObjectAsNull, teamCurrentPayload, repositoryHostCurrentPayload, projectCurrentPayload, hubRepositoryCurrentPayload, productCurrentPayload, catalogArtifactCurrentPayload, ensureProjectSeedDependencies, reconcilePlanWithStore, applyAction, seedRunInput, createSeedRunIfAvailable, updateSeedRunIfAvailable, planApprovalMetadata, approvalMatchesPlan, findApprovalAnchor, createProductionApproval, redactSeedApplyResult, localBootstrapEmails, findLocalSeedOwnerUser, exportSeedWithStore, exportSeedFromCli } from './index.js';

export function seedActorUser(actor) {
    const principal = actor?.principal;
    if (!principal?.id || principal.roles?.includes?.('team_api_key') || principal.roles?.includes?.('project_api')) {
        return null;
    }
    return {
        id: principal.id,
        email: principal.metadata?.email ?? null,
    };
}

export async function ensureLocalSeedTeamMemberships({ store, plan, ids, env, actor }) {
    if (!plan.environments.includes('local'))
        return [];
    const user = seedActorUser(actor) ?? await findLocalSeedOwnerUser(store, env);
    if (!user?.id)
        return [];
    const memberships = [];
    for (const action of selectedActions(plan).filter((entry) => entry.kind === 'team')) {
        const teamId = ids.teams.get(action.key) ?? action.existing?.id;
        if (!teamId)
            continue;
        const existing = await store.resolvePrincipalTeamContext(teamId, { id: user.id, roles: [] });
        if (existing?.membershipId)
            continue;
        const member = await store.upsertTeamMember(teamId, user.id, 'team_owner');
        if (member) {
            memberships.push({
                teamId,
                teamKey: action.key,
                userId: user.id,
                email: user.email ?? null,
                role: 'team_owner',
            });
        }
    }
    return memberships;
}

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

export async function planLocalSeedFromCli(input) {
    return planSeedWithStore(input);
}

export async function applyLocalSeedFromCli(input) {
    return applySeedWithStore({
        ...input,
        localOnly: true,
        actor: input.actor ?? { actorType: 'local', id: 'cli' },
    });
}
