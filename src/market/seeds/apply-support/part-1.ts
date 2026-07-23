import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveApiDatabaseUrl } from '@treeseed/sdk/api';
import { loadAndPlanSeed } from '@treeseed/sdk/seeds';
import YAML from 'yaml';
import { createMarketPostgresDatabase } from '../../../api/market-postgres.js';
import { MarketControlPlaneStore } from '../../../api/store.js';
import { reconcilePlanWithStore, applyAction, seedRunInput, createSeedRunIfAvailable, updateSeedRunIfAvailable, planApprovalMetadata, approvalMatchesPlan, findApprovalAnchor, createProductionApproval, redactSeedApplyResult, localBootstrapEmails, findLocalSeedOwnerUser, seedActorUser, ensureLocalSeedTeamMemberships, planSeedWithStore, applySeedWithStore, planLocalSeedFromCli, applyLocalSeedFromCli, exportSeedWithStore, exportSeedFromCli } from './index.js';

export function isoNow() {
    return new Date().toISOString();
}

export function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

export function stripSeedRuntimeMetadata(metadata) {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    const seed = source.seed && typeof source.seed === 'object' ? source.seed : null;
    return {
        ...source,
        ...(seed
            ? {
                seed: {
                    name: seed.name,
                    resourceKey: seed.resourceKey,
                    version: seed.version,
                },
            }
            : {}),
    };
}

export function comparablePayload(payload) {
    const next = { ...(payload ?? {}) };
    if (next.metadata && typeof next.metadata === 'object') {
        next.metadata = stripSeedRuntimeMetadata(next.metadata);
    }
    return next;
}

export function actionIsUnchanged(action, currentPayload) {
    return stableJson(comparablePayload(action.payload)) === stableJson(comparablePayload(currentPayload));
}

export function mergeSeedMetadata(existingMetadata, desiredMetadata, action, manifestHash, appliedAt) {
    const desiredSeed = desiredMetadata?.seed && typeof desiredMetadata.seed === 'object' ? desiredMetadata.seed : {};
    return {
        ...(existingMetadata && typeof existingMetadata === 'object' ? existingMetadata : {}),
        ...(desiredMetadata && typeof desiredMetadata === 'object' ? desiredMetadata : {}),
        seed: {
            ...desiredSeed,
            name: desiredSeed.name ?? action.payload?.metadata?.seed?.name,
            version: desiredSeed.version ?? action.payload?.metadata?.seed?.version ?? 1,
            resourceKey: desiredSeed.resourceKey ?? action.key,
            lastAppliedAt: appliedAt,
            manifestHash,
        },
    };
}

export function resolveLocalSeedEnv(_projectRoot, env = process.env) {
    const localEnv: Record<string, string | undefined> = {
        ...env,
        TREESEED_ENVIRONMENT: env.TREESEED_ENVIRONMENT ?? 'local',
        TREESEED_API_ENVIRONMENT: env.TREESEED_API_ENVIRONMENT ?? 'local',
        TREESEED_LOCAL_DEV_MODE: env.TREESEED_LOCAL_DEV_MODE ?? 'local',
    };
    const apiDatabaseUrl = resolveApiDatabaseUrl(localEnv, localEnv.TREESEED_API_BASE_URL ?? 'http://127.0.0.1:3000');
    if (apiDatabaseUrl && !localEnv.TREESEED_DATABASE_URL) {
        localEnv.TREESEED_DATABASE_URL = apiDatabaseUrl;
    }
    return localEnv;
}

export async function createLocalSeedStore(projectRoot, env = process.env) {
    const localEnv = resolveLocalSeedEnv(projectRoot, env);
    const apiDatabaseUrl = localEnv.TREESEED_DATABASE_URL?.trim();
    if (!apiDatabaseUrl) {
        throw new Error('TREESEED_DATABASE_URL could not be resolved for local Treeseed seed apply.');
    }
    const db = createMarketPostgresDatabase(apiDatabaseUrl);
    return new MarketControlPlaneStore({
        repoRoot: projectRoot,
        projectId: localEnv.TREESEED_PROJECT_ID ?? 'treeseed-market',
        authSecret: localEnv.TREESEED_AUTH_SECRET ?? localEnv.TREESEED_API_AUTH_SECRET ?? localEnv.TREESEED_BETTER_AUTH_SECRET ?? 'treeseed-local-seed-auth-secret',
        assertionSecret: localEnv.TREESEED_WEB_ASSERTION_SECRET ?? localEnv.TREESEED_API_WEB_ASSERTION_SECRET ?? 'treeseed-local-seed-assertion-secret',
        serviceId: localEnv.TREESEED_WEB_SERVICE_ID ?? localEnv.TREESEED_API_SERVICE_ID ?? 'web',
        serviceSecret: localEnv.TREESEED_WEB_SERVICE_SECRET ?? localEnv.TREESEED_API_WEB_SERVICE_SECRET ?? localEnv.TREESEED_API_SERVICE_SECRET ?? 'treeseed-local-seed-service-secret',
    }, db);
}

export function manifestHashFor(path) {
    return createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex');
}

export function slugKey(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._/-]+/gu, '-')
        .replace(/^-+|-+$/gu, '') || 'item';
}

export function generatedKey(prefix, ...parts) {
    return `${prefix}:${parts.map(slugKey).join('/')}`;
}

export function seededKey(metadata, fallback) {
    const key = metadata?.seed?.resourceKey;
    return typeof key === 'string' && key.trim() ? key.trim() : fallback;
}

export function exportMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object')
        return undefined;
    const { seed: _seed, ...rest } = metadata;
    return Object.keys(rest).length > 0 ? rest : undefined;
}

export function maybeAssign(target, key, value) {
    if (value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')) {
        target[key] = value;
    }
}

export function pruneNullish(value) {
    if (Array.isArray(value))
        return value.map(pruneNullish);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([, entry]) => entry !== undefined && entry !== null)
        .map(([key, entry]) => [key, pruneNullish(entry)]));
}

export function sortBy(...selectors) {
    return (left, right) => {
        for (const selector of selectors) {
            const result = String(selector(left) ?? '').localeCompare(String(selector(right) ?? ''));
            if (result !== 0)
                return result;
        }
        return 0;
    };
}

export function normalizeExportEnvironments(environments) {
    const raw = Array.isArray(environments)
        ? environments
        : typeof environments === 'string'
            ? environments.split(',')
            : ['local', 'staging', 'prod'];
    const selected = raw.map((entry) => String(entry).trim()).filter(Boolean).filter((entry) => ['local', 'staging', 'prod'].includes(entry));
    return [...new Set(selected.length ? selected : ['local', 'staging', 'prod'])];
}

export function selectedActions(plan) {
    return plan.actions.filter((action) => action.action !== 'skip' && action.environments.some((environment) => plan.environments.includes(environment)));
}

export function mutationActions(plan) {
    return selectedActions(plan).filter((action) => action.action === 'create' || action.action === 'update');
}

export function actorId(actor) {
    return typeof actor?.principal?.id === 'string' ? actor.principal.id : typeof actor?.id === 'string' ? actor.id : null;
}

export function actorType(actor) {
    return actor?.actorType ?? actor?.type ?? 'local';
}

export function manifestRefIsAllowed(seedName, manifestRef) {
    return manifestRef === undefined || manifestRef === null || manifestRef === '' || manifestRef === `seeds/${seedName}.yaml`;
}

export function emptyObjectAsNull(value) {
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 ? null : value ?? null;
}

export function teamCurrentPayload(action, team) {
    if (!team)
        return null;
    return {
        slug: action.payload.slug,
        name: action.payload.name,
        displayName: team.displayName ?? action.payload.displayName,
        logoUrl: team.logoUrl ?? null,
        profileSummary: team.profileSummary ?? null,
        metadata: action.payload.metadata,
    };
}

export function repositoryHostCurrentPayload(action, host) {
    if (!host)
        return null;
    return {
        teamKey: action.payload.teamKey,
        provider: host.provider,
        name: host.name,
        ownership: host.ownership,
        accountLabel: host.accountLabel ?? null,
        organizationOrOwner: host.organizationOrOwner,
        defaultVisibility: host.defaultVisibility ?? 'private',
        softwareRepositoryNameTemplate: host.softwareRepositoryNameTemplate ?? null,
        contentRepositoryNameTemplate: host.contentRepositoryNameTemplate ?? null,
        branchPolicy: emptyObjectAsNull(host.branchPolicy),
        workflowPolicy: emptyObjectAsNull(host.workflowPolicy),
        allowedProjectKinds: host.allowedProjectKinds?.length ? host.allowedProjectKinds : null,
        status: host.status ?? 'active',
        credentialRef: host.metadata?.credentialRef ?? action.payload.credentialRef ?? null,
        metadata: action.payload.metadata,
    };
}

export async function projectCurrentPayload(store, action, project) {
    if (!project)
        return null;
    const repository = action.payload.repository;
    const hubRepository = (await store.listHubRepositories(project.id)).find((entry) => entry.role === repository.role) ?? null;
    return {
        teamKey: action.payload.teamKey,
        slug: project.slug,
        name: project.name,
        description: project.description ?? null,
        kind: action.payload.kind ?? null,
        repository: hubRepository
            ? {
                role: hubRepository.role,
                provider: hubRepository.provider,
                owner: hubRepository.owner,
                name: hubRepository.name,
                gitUrl: hubRepository.url,
                defaultBranch: hubRepository.defaultBranch ?? undefined,
                checkoutPath: repository.checkoutPath,
                submodulePath: hubRepository.submodulePath ?? undefined,
                webUrl: repository.webUrl,
            }
            : null,
        architecture: project.metadata?.architecture,
        metadata: action.payload.metadata,
    };
}

export function hubRepositoryCurrentPayload(action, repository) {
    if (!repository)
        return null;
    return {
        projectKey: action.payload.projectKey,
        repositoryHostKey: action.payload.repositoryHostKey ?? null,
        role: repository.role,
        provider: repository.provider,
        owner: repository.owner,
        name: repository.name,
        gitUrl: repository.url,
        defaultBranch: repository.defaultBranch ?? null,
        currentBranch: repository.currentBranch ?? repository.defaultBranch ?? null,
        submodulePath: repository.submodulePath ?? null,
        status: repository.status ?? 'active',
        accessPolicy: emptyObjectAsNull(repository.accessPolicy),
        releasePolicy: emptyObjectAsNull(repository.releasePolicy),
        publishPolicy: emptyObjectAsNull(repository.publishPolicy),
        metadata: action.payload.metadata,
    };
}

export function productCurrentPayload(action, product) {
    if (!product)
        return null;
    return {
        teamKey: action.payload.teamKey,
        kind: product.kind,
        slug: product.slug,
        title: product.title,
        summary: product.summary ?? null,
        visibility: product.visibility ?? 'private',
        listingEnabled: product.listingEnabled === true,
        offerMode: product.offerMode ?? 'private',
        manifestKey: product.manifestKey ?? null,
        artifactKey: product.artifactKey ?? null,
        searchText: product.searchText ?? null,
        metadata: action.payload.metadata,
    };
}

export function catalogArtifactCurrentPayload(action, artifact) {
    if (!artifact)
        return null;
    return {
        productKey: action.payload.productKey,
        version: artifact.version,
        kind: artifact.kind,
        contentKey: artifact.contentKey,
        manifestKey: artifact.manifestKey ?? null,
        publishedAt: action.payload.publishedAt ?? null,
        metadata: action.payload.metadata,
    };
}

export async function ensureProjectSeedDependencies({ action, store, ids, manifestHash, appliedAt }) {
    if (action.kind !== 'project')
        return [];
    const projectId = ids.projects.get(action.key) ?? action.existing?.id;
    const teamId = ids.teams.get(action.payload.teamKey);
    const repository = action.payload.repository;
    if (!projectId || !teamId || !repository)
        return [];
    const repairs = [];
    const metadata = mergeSeedMetadata(action.existing?.metadata, action.payload.metadata, action, manifestHash, appliedAt);
    const repositories = await store.listHubRepositories(projectId);
    const existingRepository = repositories.find((entry) => entry.role === repository.role);
    if (!existingRepository) {
        await store.upsertHubRepository(projectId, {
            teamId,
            role: repository.role,
            provider: repository.provider,
            owner: repository.owner,
            name: repository.name,
            url: repository.gitUrl,
            defaultBranch: repository.defaultBranch ?? 'main',
            currentBranch: repository.defaultBranch ?? 'main',
            status: 'active',
            submodulePath: repository.submodulePath ?? null,
            metadata,
        });
        repairs.push({ kind: 'hubRepository', projectId, role: repository.role });
    }
    const hosting = await store.getProjectHosting(projectId);
    const connection = await store.getProjectConnection(projectId);
    if (!hosting) {
        await store.upsertProjectHosting(projectId, {
            kind: 'self_hosted_project',
            registration: 'optional',
            sourceRepoOwner: repository.owner,
            sourceRepoName: repository.name,
            sourceRepoUrl: repository.gitUrl,
            sourceRepoWorkflowPath: '.github/workflows/deploy.yml',
            executionOwner: 'project_runner',
            metadata: {
                ...metadata,
                source: 'seed',
                seededConnection: true,
            },
        });
        repairs.push({ kind: 'projectHosting', projectId });
    }
    else if (!connection) {
        await store.upsertProjectHosting(projectId, {
            kind: hosting.kind,
            registration: hosting.registration,
            marketBaseUrl: hosting.marketBaseUrl,
            sourceRepoOwner: hosting.sourceRepoOwner,
            sourceRepoName: hosting.sourceRepoName,
            sourceRepoUrl: hosting.sourceRepoUrl,
            sourceRepoWorkflowPath: hosting.sourceRepoWorkflowPath,
            executionOwner: hosting.metadata?.executionOwner ?? 'project_runner',
            metadata: hosting.metadata,
        });
        repairs.push({ kind: 'projectConnection', projectId });
    }
    return repairs;
}
