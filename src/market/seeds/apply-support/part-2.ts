import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveApiDatabaseUrl } from '@treeseed/sdk/api';
import { loadAndPlanSeed } from '@treeseed/sdk/seeds';
import YAML from 'yaml';
import { createMarketPostgresDatabase } from '../../../api/market-postgres.js';
import { MarketControlPlaneStore } from '../../../api/store.js';
import { isoNow, stableJson, stripSeedRuntimeMetadata, comparablePayload, actionIsUnchanged, mergeSeedMetadata, resolveLocalSeedEnv, createLocalSeedStore, manifestHashFor, slugKey, generatedKey, seededKey, exportMetadata, maybeAssign, pruneNullish, sortBy, normalizeExportEnvironments, selectedActions, mutationActions, actorId, actorType, manifestRefIsAllowed, emptyObjectAsNull, teamCurrentPayload, repositoryHostCurrentPayload, projectCurrentPayload, hubRepositoryCurrentPayload, productCurrentPayload, catalogArtifactCurrentPayload, ensureProjectSeedDependencies, seedActorUser, ensureLocalSeedTeamMemberships, planSeedWithStore, applySeedWithStore, planLocalSeedFromCli, applyLocalSeedFromCli, exportSeedWithStore, exportSeedFromCli } from './index.js';

export async function reconcilePlanWithStore(plan, store) {
    const teamIds = new Map();
    const repositoryHostIds = new Map();
    const projectIds = new Map();
    const productIds = new Map();
    const nextActions = [];
    for (const action of plan.actions) {
        if (action.action === 'skip') {
            nextActions.push(action);
            continue;
        }
        let existing = null;
        let currentPayload = null;
        if (action.kind === 'team') {
            existing = await store.getTeamBySlug(action.payload.slug);
            if (existing)
                teamIds.set(action.key, existing.id);
            currentPayload = teamCurrentPayload(action, existing);
        }
        if (action.kind === 'repositoryHost') {
            const teamId = teamIds.get(action.payload.teamKey);
            existing = teamId
                ? (await store.listRepositoryHosts(teamId, { includePlatform: true })).find((host) => host.provider === action.payload.provider && host.name === action.payload.name) ?? null
                : null;
            if (existing)
                repositoryHostIds.set(action.key, existing.id);
            currentPayload = repositoryHostCurrentPayload(action, existing);
        }
        if (action.kind === 'project') {
            const teamId = teamIds.get(action.payload.teamKey);
            existing = teamId ? await store.getProjectByTeamAndSlug(teamId, action.payload.slug) : null;
            if (existing)
                projectIds.set(action.key, existing.id);
            currentPayload = teamId ? await projectCurrentPayload(store, action, existing) : null;
        }
        if (action.kind === 'hubRepository') {
            const projectId = projectIds.get(action.payload.projectKey);
            existing = projectId ? (await store.listHubRepositories(projectId)).find((repository) => repository.role === action.payload.role) ?? null : null;
            if (existing)
                repositoryHostIds.set(action.payload.repositoryHostKey, existing.repositoryHostId);
            currentPayload = hubRepositoryCurrentPayload(action, existing);
        }
        if (action.kind === 'product') {
            const teamId = teamIds.get(action.payload.teamKey);
            const product = await store.getCatalogItemBySlug(action.payload.kind, action.payload.slug);
            existing = product?.teamId === teamId ? product : null;
            if (existing)
                productIds.set(action.key, existing.id);
            currentPayload = productCurrentPayload(action, existing);
        }
        if (action.kind === 'catalogArtifact') {
            const productId = productIds.get(action.payload.productKey);
            existing = productId ? await store.getCatalogArtifactVersion(productId, action.payload.version) : null;
            currentPayload = catalogArtifactCurrentPayload(action, existing);
        }
        nextActions.push({
            ...action,
            action: currentPayload ? actionIsUnchanged(action, currentPayload) ? 'unchanged' : 'update' : 'create',
            existing,
        });
    }
    return {
        ...plan,
        actions: nextActions,
        summary: nextActions.reduce((summary, action) => {
            summary[action.action] += 1;
            return summary;
        }, { create: 0, update: 0, unchanged: 0, skip: 0, delete: 0, error: 0 }),
    };
}

export async function applyAction({ action, store, ids, manifestHash, appliedAt, plan }) {
    if (action.action === 'skip' || action.action === 'unchanged')
        return null;
    const metadata = mergeSeedMetadata(action.existing?.metadata, action.payload.metadata, action, manifestHash, appliedAt);
    if (action.kind === 'team') {
        const existing = action.existing;
        const team = existing
            ? (await store.updateTeamSettings(existing.id, {
                name: action.payload.name,
                displayName: action.payload.displayName,
                logoUrl: action.payload.logoUrl,
                profileSummary: action.payload.profileSummary,
                metadata,
            })).ok === false ? existing : await store.getTeam(existing.id)
            : await store.createTeam({
                slug: action.payload.slug,
                name: action.payload.name,
                displayName: action.payload.displayName,
                logoUrl: action.payload.logoUrl,
                profileSummary: action.payload.profileSummary,
                metadata,
            });
        ids.teams.set(action.key, team.id);
        return team;
    }
    if (action.kind === 'repositoryHost') {
        const teamId = ids.teams.get(action.payload.teamKey);
        if (!teamId)
            throw new Error(`Missing team for ${action.key}.`);
        const host = await store.upsertRepositoryHost(teamId, {
            id: action.existing?.id,
            teamId,
            provider: action.payload.provider,
            ownership: action.payload.ownership ?? 'treeseed_managed',
            name: action.payload.name,
            accountLabel: action.payload.accountLabel,
            organizationOrOwner: action.payload.organizationOrOwner,
            defaultVisibility: action.payload.defaultVisibility ?? 'private',
            softwareRepositoryNameTemplate: action.payload.softwareRepositoryNameTemplate,
            contentRepositoryNameTemplate: action.payload.contentRepositoryNameTemplate,
            branchPolicy: action.payload.branchPolicy ?? {},
            workflowPolicy: action.payload.workflowPolicy ?? {},
            allowedProjectKinds: action.payload.allowedProjectKinds ?? [],
            status: action.payload.status ?? 'active',
            metadata: {
                ...metadata,
                ...(action.payload.credentialRef ? { credentialRef: action.payload.credentialRef } : {}),
            },
        });
        ids.repositoryHosts.set(action.key, host.id);
        return host;
    }
    if (action.kind === 'project') {
        const teamId = ids.teams.get(action.payload.teamKey);
        if (!teamId)
            throw new Error(`Missing team for ${action.key}.`);
        const projectMetadata = {
            metadata,
            kind: action.payload.kind,
            repository: action.payload.repository,
            architecture: action.payload.architecture,
        };
        const project = action.existing
            ? await store.updateProject(action.existing.id, {
                slug: action.payload.slug,
                name: action.payload.name,
                description: action.payload.description,
                metadata: projectMetadata,
            })
            : (await store.createProject(teamId, {
                slug: action.payload.slug,
                name: action.payload.name,
                description: action.payload.description,
                metadata: projectMetadata,
            })).project;
        ids.projects.set(action.key, project.id);
        return project;
    }
    if (action.kind === 'hubRepository') {
        const projectId = ids.projects.get(action.payload.projectKey);
        if (!projectId)
            throw new Error(`Missing project for ${action.key}.`);
        const projectAction = plan.actions.find((entry) => entry.key === action.payload.projectKey);
        const teamId = projectAction ? ids.teams.get(projectAction.payload.teamKey) : null;
        if (!teamId)
            throw new Error(`Missing team for ${action.key}.`);
        const repository = await store.upsertHubRepository(projectId, {
            id: action.existing?.id,
            teamId,
            role: action.payload.role,
            repositoryHostId: action.payload.repositoryHostKey ? ids.repositoryHosts.get(action.payload.repositoryHostKey) ?? null : null,
            provider: action.payload.provider,
            owner: action.payload.owner,
            name: action.payload.name,
            url: action.payload.gitUrl,
            defaultBranch: action.payload.defaultBranch ?? 'main',
            currentBranch: action.payload.currentBranch ?? action.payload.defaultBranch ?? 'main',
            status: action.payload.status ?? 'active',
            accessPolicy: action.payload.accessPolicy ?? {},
            releasePolicy: action.payload.releasePolicy ?? {},
            publishPolicy: action.payload.publishPolicy ?? {},
            submodulePath: action.payload.submodulePath ?? null,
            metadata,
        });
        return repository;
    }
    if (action.kind === 'product') {
        const teamId = ids.teams.get(action.payload.teamKey);
        if (!teamId)
            throw new Error(`Missing team for ${action.key}.`);
        const product = await store.upsertCatalogItem(teamId, {
            id: action.existing?.id,
            kind: action.payload.kind,
            slug: action.payload.slug,
            title: action.payload.title,
            summary: action.payload.summary,
            visibility: action.payload.visibility ?? 'private',
            listingEnabled: action.payload.listingEnabled === true,
            offerMode: action.payload.offerMode ?? 'private',
            manifestKey: action.payload.manifestKey,
            artifactKey: action.payload.artifactKey,
            searchText: action.payload.searchText,
            metadata,
        });
        ids.products.set(action.key, product.id);
        ids.productTeams.set(action.key, teamId);
        return product;
    }
    if (action.kind === 'catalogArtifact') {
        const productId = ids.products.get(action.payload.productKey);
        const teamId = ids.productTeams.get(action.payload.productKey);
        if (!teamId || !productId)
            throw new Error(`Missing product for ${action.key}.`);
        return store.upsertCatalogArtifactVersion(teamId, productId, {
            id: action.existing?.id,
            version: action.payload.version,
            kind: action.payload.kind,
            contentKey: action.payload.contentKey,
            manifestKey: action.payload.manifestKey,
            publishedAt: action.payload.publishedAt,
            metadata,
        });
    }
    return null;
}

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

export function planApprovalMetadata(plan, manifestHash) {
    return {
        seed: {
            name: plan.seed,
            version: plan.version,
            environments: plan.environments,
            manifestHash,
            planSummary: plan.summary,
        },
    };
}

export function approvalMatchesPlan(approval, plan, manifestHash) {
    const seed = approval?.metadata?.seed;
    return Boolean(approval
        && approval.state === 'approved'
        && seed?.name === plan.seed
        && seed?.version === plan.version
        && seed?.manifestHash === manifestHash
        && stableJson(seed?.environments ?? []) === stableJson(plan.environments)
        && stableJson(seed?.planSummary ?? {}) === stableJson(plan.summary));
}

export function findApprovalAnchor(plan) {
    const preferred = plan.actions.find((action) => action.kind === 'project' && action.key === 'project:treeseed/market' && action.existing?.id);
    const project = preferred ?? plan.actions.find((action) => action.kind === 'project' && action.existing?.id);
    if (!project)
        return null;
    const teamAction = plan.actions.find((action) => action.key === project.payload.teamKey);
    if (!teamAction?.existing?.id)
        return null;
    return {
        projectId: project.existing.id,
        projectSlug: project.existing.slug ?? project.payload.slug,
        teamId: teamAction.existing.id,
        teamSlug: teamAction.existing.slug ?? teamAction.payload.slug,
    };
}

export async function createProductionApproval({ store, plan, manifestHash, actor }) {
    const anchor = findApprovalAnchor(plan);
    if (!anchor) {
        return {
            ok: false,
            message: 'Production seed apply requires an existing seeded project approval anchor. Apply or plan staging first so the seeded market project exists.',
        };
    }
    const metadata = planApprovalMetadata(plan, manifestHash);
    const request = await store.createApprovalRequest({
        teamId: anchor.teamId,
        projectId: anchor.projectId,
        kind: 'seed_production_apply',
        severity: 'high',
        requestedByType: actorType(actor) === 'service' ? 'service' : actorType(actor) === 'agent' ? 'agent' : 'user',
        requestedById: actorId(actor),
        title: `Approve production seed apply: ${plan.seed}`,
        summary: `Apply seed ${plan.seed} to production. Planned changes: create ${plan.summary.create}, update ${plan.summary.update}, unchanged ${plan.summary.unchanged}.`,
        options: [
            { id: 'approve', label: 'Approve production seed apply' },
            { id: 'reject', label: 'Reject production seed apply' },
        ],
        recommendation: { optionId: 'approve' },
        policySnapshot: {
            policy: 'seed.production.apply.requires_approval',
            environments: plan.environments,
        },
        metadata,
    });
    await store.upsertTeamInboxItem(anchor.teamId, {
        id: `seed-approval:${request.id}`,
        projectId: anchor.projectId,
        kind: 'approval',
        state: 'waiting_for_approval',
        title: request.title,
        summary: request.summary,
        href: `/app/work/decisions#approval-${request.id}`,
        itemKey: request.id,
        metadata: {
            approvalId: request.id,
            approvalRequestId: request.id,
            approvalKind: request.kind,
            seed: metadata.seed,
        },
    });
    return { ok: true, approvalRequest: request };
}

export function redactSeedApplyResult(result) {
    return result;
}

export function localBootstrapEmails(env = process.env) {
    return String(env.TREESEED_API_BOOTSTRAP_ADMIN_ALLOWLIST ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}

export async function findLocalSeedOwnerUser(store, env = process.env) {
    const allowlist = localBootstrapEmails(env);
    for (const email of allowlist) {
        const user = typeof store.findUserByEmail === 'function' ? await store.findUserByEmail(email) : null;
        if (user?.id)
            return user;
    }
    const users = typeof store.listActiveUsers === 'function' ? await store.listActiveUsers(2) : [];
    return users.length === 1 ? users[0] : null;
}
