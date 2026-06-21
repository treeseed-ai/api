import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveApiDatabaseUrl } from '@treeseed/sdk/api';
import { loadAndPlanSeed } from '@treeseed/sdk/seeds';
import YAML from 'yaml';
import { createMarketPostgresDatabase } from '../../api/market-postgres.js';
import { MarketControlPlaneStore } from '../../api/store.js';

function isoNow() {
	return new Date().toISOString();
}

function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

function stripSeedRuntimeMetadata(metadata) {
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

function comparablePayload(payload) {
	const next = { ...(payload ?? {}) };
	if (next.metadata && typeof next.metadata === 'object') {
		next.metadata = stripSeedRuntimeMetadata(next.metadata);
	}
	return next;
}

function actionIsUnchanged(action, currentPayload) {
	return stableJson(comparablePayload(action.payload)) === stableJson(comparablePayload(currentPayload));
}

function mergeSeedMetadata(existingMetadata, desiredMetadata, action, manifestHash, appliedAt) {
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

function normalizeProviderKind(kind) {
	if (kind === 'local') return 'team_owned';
	if (kind === 'managed') return 'treeseed_managed';
	return kind ?? 'team_owned';
}

function providerManifestKind(provider) {
	return provider?.metadata?.manifestKind ?? provider?.metadata?.seedManifestKind ?? (provider?.kind === 'team_owned' && provider?.provider === 'local' ? 'local' : provider?.kind);
}

function emptyObjectAsNull(value) {
	return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 ? null : value ?? null;
}

function zeroAsNull(value) {
	return Number(value ?? 0) === 0 ? null : Number(value);
}

function normalizeNativeLimits(limits, desiredLimits = []) {
	return (Array.isArray(limits) ? limits : [])
		.map((limit) => {
			const desired = desiredLimits.find((entry) => (
				(entry.id && entry.id === limit.id)
				|| ((entry.scope ?? entry.limitScope ?? 'daily') === (limit.scope ?? 'daily') && (entry.nativeUnit ?? limit.nativeUnit) === limit.nativeUnit)
			)) ?? null;
			return {
				id: desired?.id ? limit.id ?? undefined : undefined,
				scope: limit.scope ?? undefined,
				nativeUnit: limit.nativeUnit ?? undefined,
				limitAmount: Number(limit.limitAmount ?? 0),
				reserveBufferPercent: limit.reserveBufferPercent ?? undefined,
				resetCadence: limit.resetCadence ?? undefined,
				resetAt: limit.resetAt ?? undefined,
				confidence: limit.confidence ?? undefined,
				source: limit.source ?? undefined,
				metadata: emptyObjectAsNull(limit.metadata) ?? undefined,
			};
		})
		.sort(sortBy((limit) => limit.id, (limit) => limit.scope, (limit) => limit.nativeUnit));
}

function normalizeExecutionProviders(executionProviders, desiredProviders = []) {
	return (Array.isArray(executionProviders) ? executionProviders : [])
		.map((provider) => {
			const desired = desiredProviders.find((entry) => (
				(entry.id && entry.id === provider.id)
				|| (entry.name === provider.name && entry.kind === provider.kind)
			)) ?? null;
			return {
				id: desired?.id ? provider.id ?? undefined : undefined,
				name: provider.name,
				kind: provider.kind,
				status: desired?.status ? provider.status ?? undefined : undefined,
				nativeUnit: provider.nativeUnit,
				quotaVisibility: provider.quotaVisibility ?? undefined,
				maxConcurrentWorkers: provider.maxConcurrentWorkers ?? undefined,
				resetCadence: provider.resetCadence ?? undefined,
				config: emptyObjectAsNull(provider.config) ?? undefined,
				metadata: emptyObjectAsNull(provider.metadata) ?? undefined,
				nativeLimits: normalizeNativeLimits(provider.nativeLimits, desired?.nativeLimits ?? []),
			};
		})
		.sort(sortBy((provider) => provider.id, (provider) => provider.name, (provider) => provider.kind));
}

export function resolveLocalSeedEnv(_projectRoot, env = process.env) {
	const localEnv = {
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

async function createLocalSeedStore(projectRoot, env = process.env) {
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

function manifestHashFor(path) {
	return createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex');
}

function slugKey(value) {
	return String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._/-]+/gu, '-')
		.replace(/^-+|-+$/gu, '') || 'item';
}

function generatedKey(prefix, ...parts) {
	return `${prefix}:${parts.map(slugKey).join('/')}`;
}

function seededKey(metadata, fallback) {
	const key = metadata?.seed?.resourceKey;
	return typeof key === 'string' && key.trim() ? key.trim() : fallback;
}

function exportMetadata(metadata) {
	if (!metadata || typeof metadata !== 'object') return undefined;
	const { seed: _seed, ...rest } = metadata;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

function maybeAssign(target, key, value) {
	if (value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')) {
		target[key] = value;
	}
}

function pruneNullish(value) {
	if (Array.isArray(value)) return value.map(pruneNullish);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, entry]) => entry !== undefined && entry !== null)
			.map(([key, entry]) => [key, pruneNullish(entry)]),
	);
}

function sortBy(...selectors) {
	return (left, right) => {
		for (const selector of selectors) {
			const result = String(selector(left) ?? '').localeCompare(String(selector(right) ?? ''));
			if (result !== 0) return result;
		}
		return 0;
	};
}

function normalizeExportEnvironments(environments) {
	const raw = Array.isArray(environments)
		? environments
		: typeof environments === 'string'
			? environments.split(',')
			: ['local', 'staging', 'prod'];
	const selected = raw.map((entry) => String(entry).trim()).filter(Boolean).filter((entry) => ['local', 'staging', 'prod'].includes(entry));
	return [...new Set(selected.length ? selected : ['local', 'staging', 'prod'])];
}

function selectedActions(plan) {
	return plan.actions.filter((action) => action.action !== 'skip' && action.environments.some((environment) => plan.environments.includes(environment)));
}

function mutationActions(plan) {
	return selectedActions(plan).filter((action) => action.action === 'create' || action.action === 'update');
}

function actorId(actor) {
	return typeof actor?.principal?.id === 'string' ? actor.principal.id : typeof actor?.id === 'string' ? actor.id : null;
}

function actorType(actor) {
	return actor?.actorType ?? actor?.type ?? 'local';
}

function manifestRefIsAllowed(seedName, manifestRef) {
	return manifestRef === undefined || manifestRef === null || manifestRef === '' || manifestRef === `seeds/${seedName}.yaml`;
}

async function findProviderByName(store, teamId, name) {
	return (await store.listTeamCapacityProviders(teamId)).find((provider) => provider.name === name) ?? null;
}

async function findLaneByName(store, teamId, providerId, name) {
	return (await store.listCapacityProviderLanes(teamId, providerId)).find((lane) => lane.name === name) ?? null;
}

async function findGrant(store, teamId, input) {
	return (await store.listCapacityGrants(teamId, {
		providerId: input.capacityProviderId,
		projectId: input.projectId ?? null,
	})).find((grant) => (
		grant.capacityProviderId === input.capacityProviderId
		&& (grant.laneId ?? null) === (input.laneId ?? null)
		&& grant.teamId === (input.teamId ?? teamId)
		&& (grant.projectId ?? null) === (input.projectId ?? null)
		&& (grant.environment ?? null) === (input.environment ?? null)
		&& (grant.grantScope ?? 'team') === (input.grantScope ?? 'team')
	)) ?? null;
}

function teamCurrentPayload(action, team) {
	if (!team) return null;
	return {
		slug: action.payload.slug,
		name: action.payload.name,
		displayName: team.displayName ?? action.payload.displayName,
		logoUrl: team.logoUrl ?? null,
		profileSummary: team.profileSummary ?? null,
		metadata: action.payload.metadata,
	};
}

function repositoryHostCurrentPayload(action, host) {
	if (!host) return null;
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

async function projectCurrentPayload(store, action, project) {
	if (!project) return null;
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

function hubRepositoryCurrentPayload(action, repository) {
	if (!repository) return null;
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

async function providerCurrentPayload(store, teamId, action, provider) {
	if (!provider) return null;
	const executionProviders = teamId && typeof store.listExecutionProviders === 'function'
		? await store.listExecutionProviders(teamId, provider.id)
		: [];
	return {
		teamKey: action.payload.teamKey,
		name: provider.name,
		kind: providerManifestKind(provider),
		provider: provider.provider,
		billingScope: provider.billingScope ?? null,
			creditBudgetMode: provider.creditBudgetMode ?? 'derived',
		monthlyCreditBudget: zeroAsNull(provider.monthlyCreditBudget),
		dailyCreditBudget: zeroAsNull(provider.dailyCreditBudget),
		maxConcurrentWorkdays: provider.maxConcurrentWorkdays ?? null,
		maxConcurrentWorkers: provider.maxConcurrentWorkers ?? null,
		capacityModel: emptyObjectAsNull(provider.capacityModel),
		registration: action.payload.registration ?? null,
		executionProviders: normalizeExecutionProviders(executionProviders, action.payload.executionProviders ?? []),
		metadata: action.payload.metadata,
	};
}

function laneCurrentPayload(action, lane) {
	if (!lane) return null;
	return {
		providerKey: action.payload.providerKey,
		name: lane.name,
		businessModel: lane.businessModel ?? null,
		modelFamily: lane.modelFamily ?? null,
		modelClass: lane.modelClass ?? null,
		regionPolicy: lane.regionPolicy ?? null,
		unit: lane.unit ?? null,
		scarcityLevel: lane.scarcityLevel ?? null,
		hardLimits: emptyObjectAsNull(lane.hardLimits),
		routingPolicy: emptyObjectAsNull(lane.routingPolicy),
		metadata: action.payload.metadata,
	};
}

function grantCurrentPayload(action, grant) {
	if (!grant) return null;
	return {
		providerKey: action.payload.providerKey,
		laneKey: action.payload.laneKey ?? null,
		teamKey: action.payload.teamKey,
		projectKey: action.payload.projectKey ?? null,
		environment: grant.environment ?? null,
		grantScope: grant.grantScope ?? null,
		dailyCreditLimit: grant.dailyCreditLimit ?? null,
		weeklyCreditLimit: grant.weeklyCreditLimit ?? null,
		monthlyCreditLimit: grant.monthlyCreditLimit ?? null,
		dailyUsdLimit: grant.dailyUsdLimit ?? null,
		weeklyQuotaMinutes: grant.weeklyQuotaMinutes ?? null,
		monthlyProviderUnits: grant.monthlyProviderUnits ?? null,
		portfolioAllocationPercent: grant.portfolioAllocationPercent ?? null,
		reservePoolPercent: grant.reservePoolPercent ?? null,
		maxDailyProjectCredits: grant.maxDailyProjectCredits ?? null,
		emergencyOverride: action.payload.emergencyOverride === true ? grant.emergencyOverride === true : null,
		priorityWeight: grant.priorityWeight ?? null,
		overflowPolicy: grant.overflowPolicy ?? null,
		state: action.payload.state ?? (grant.state === 'active' ? null : grant.state ?? null),
		metadata: action.payload.metadata,
	};
}

function workPolicyCurrentPayload(action, policy) {
	if (!policy) return null;
	return {
		projectKey: action.payload.projectKey,
		environment: policy.environment,
		enabled: policy.enabled ?? true,
		startCron: policy.startCron ?? '0 9 * * 1-5',
		durationMinutes: policy.durationMinutes ?? 480,
		maxRunners: policy.maxRunners ?? 1,
		maxWorkersPerRunner: policy.maxWorkersPerRunner ?? 4,
		dailyCreditBudget: policy.dailyCreditBudget ?? null,
		maxQueuedTasks: policy.maxQueuedTasks ?? null,
		maxQueuedCredits: policy.maxQueuedCredits ?? null,
		autoscale: Object.keys(policy.autoscale ?? {}).length > 0 ? policy.autoscale : null,
		creditWeights: (policy.creditWeights ?? []).length > 0 ? policy.creditWeights : null,
		metadata: action.payload.metadata,
	};
}

function productCurrentPayload(action, product) {
	if (!product) return null;
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

function catalogArtifactCurrentPayload(action, artifact) {
	if (!artifact) return null;
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

async function ensureProjectSeedDependencies({ action, store, ids, manifestHash, appliedAt }) {
	if (action.kind !== 'project') return [];
	const projectId = ids.projects.get(action.key) ?? action.existing?.id;
	const teamId = ids.teams.get(action.payload.teamKey);
	const repository = action.payload.repository;
	if (!projectId || !teamId || !repository) return [];
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
	} else if (!connection) {
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

async function reconcilePlanWithStore(plan, store) {
	const teamIds = new Map();
	const repositoryHostIds = new Map();
	const projectIds = new Map();
	const providerIds = new Map();
	const laneIds = new Map();
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
			if (existing) teamIds.set(action.key, existing.id);
			currentPayload = teamCurrentPayload(action, existing);
		}
		if (action.kind === 'repositoryHost') {
			const teamId = teamIds.get(action.payload.teamKey);
			existing = teamId
				? (await store.listRepositoryHosts(teamId, { includePlatform: true })).find((host) => host.provider === action.payload.provider && host.name === action.payload.name) ?? null
				: null;
			if (existing) repositoryHostIds.set(action.key, existing.id);
			currentPayload = repositoryHostCurrentPayload(action, existing);
		}
		if (action.kind === 'project') {
			const teamId = teamIds.get(action.payload.teamKey);
			existing = teamId ? await store.getProjectByTeamAndSlug(teamId, action.payload.slug) : null;
			if (existing) projectIds.set(action.key, existing.id);
			currentPayload = teamId ? await projectCurrentPayload(store, action, existing) : null;
		}
		if (action.kind === 'hubRepository') {
			const projectId = projectIds.get(action.payload.projectKey);
			existing = projectId ? (await store.listHubRepositories(projectId)).find((repository) => repository.role === action.payload.role) ?? null : null;
			if (existing) repositoryHostIds.set(action.payload.repositoryHostKey, existing.repositoryHostId);
			currentPayload = hubRepositoryCurrentPayload(action, existing);
		}
		if (action.kind === 'capacityProvider') {
			const teamId = teamIds.get(action.payload.teamKey);
			existing = teamId ? await findProviderByName(store, teamId, action.payload.name) : null;
			if (existing) providerIds.set(action.key, existing.id);
			currentPayload = await providerCurrentPayload(store, teamId, action, existing);
		}
		if (action.kind === 'capacityLane') {
			const providerId = providerIds.get(action.payload.providerKey);
			const providerAction = plan.actions.find((entry) => entry.key === action.payload.providerKey);
			const teamId = providerAction ? teamIds.get(providerAction.payload.teamKey) : null;
			existing = teamId && providerId ? await findLaneByName(store, teamId, providerId, action.payload.name) : null;
			if (existing) laneIds.set(action.key, existing.id);
			currentPayload = laneCurrentPayload(action, existing);
		}
		if (action.kind === 'capacityGrant') {
			const providerId = providerIds.get(action.payload.providerKey);
			const teamId = teamIds.get(action.payload.teamKey);
			const input = providerId && teamId
				? {
					capacityProviderId: providerId,
					laneId: action.payload.laneKey ? laneIds.get(action.payload.laneKey) ?? null : null,
					teamId,
					projectId: action.payload.projectKey ? projectIds.get(action.payload.projectKey) ?? null : null,
					environment: action.payload.environment ?? null,
					grantScope: action.payload.grantScope ?? 'team',
				}
				: null;
			existing = input ? await findGrant(store, teamId, input) : null;
			currentPayload = grantCurrentPayload(action, existing);
		}
		if (action.kind === 'workPolicy') {
			const projectId = projectIds.get(action.payload.projectKey);
			existing = projectId ? await store.getProjectWorkPolicy(projectId, action.payload.environment) : null;
			currentPayload = workPolicyCurrentPayload(action, existing);
		}
		if (action.kind === 'product') {
			const teamId = teamIds.get(action.payload.teamKey);
			const product = await store.getCatalogItemBySlug(action.payload.kind, action.payload.slug);
			existing = product?.teamId === teamId ? product : null;
			if (existing) productIds.set(action.key, existing.id);
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

async function applyAction({ action, store, ids, manifestHash, appliedAt, plan }) {
	if (action.action === 'skip' || action.action === 'unchanged') return null;
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
		if (!teamId) throw new Error(`Missing team for ${action.key}.`);
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
		if (!teamId) throw new Error(`Missing team for ${action.key}.`);
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
		if (!projectId) throw new Error(`Missing project for ${action.key}.`);
		const projectAction = plan.actions.find((entry) => entry.key === action.payload.projectKey);
		const teamId = projectAction ? ids.teams.get(projectAction.payload.teamKey) : null;
		if (!teamId) throw new Error(`Missing team for ${action.key}.`);
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
	if (action.kind === 'capacityProvider') {
		const teamId = ids.teams.get(action.payload.teamKey);
		if (!teamId) throw new Error(`Missing team for ${action.key}.`);
		let provider;
		try {
			provider = await store.upsertCapacityProvider(teamId, {
				id: action.existing?.id,
				teamId,
				ownerTeamId: teamId,
				name: action.payload.name,
				kind: normalizeProviderKind(action.payload.kind),
				status: 'active',
					provider: action.payload.provider,
					billingScope: action.payload.billingScope ?? 'team',
					creditBudgetMode: action.payload.creditBudgetMode ?? 'derived',
					monthlyCreditBudget: action.payload.monthlyCreditBudget ?? 0,
					dailyCreditBudget: action.payload.dailyCreditBudget ?? 0,
				maxConcurrentWorkdays: action.payload.maxConcurrentWorkdays ?? 1,
				maxConcurrentWorkers: action.payload.maxConcurrentWorkers ?? 1,
				capacityModel: action.payload.capacityModel ?? {},
				metadata: {
					...metadata,
					manifestKind: action.payload.kind,
				},
			});
		} catch (error) {
			throw new Error(`Unable to upsert capacity provider ${action.key} for team ${teamId}: ${error instanceof Error ? error.message : String(error)}`);
		}
		ids.providers.set(action.key, provider.id);
		for (const executionProvider of action.payload.executionProviders ?? []) {
			await store.upsertExecutionProvider(teamId, provider.id, executionProvider);
		}
		return provider;
	}
	if (action.kind === 'capacityLane') {
		const providerId = ids.providers.get(action.payload.providerKey);
		const providerAction = plan.actions.find((entry) => entry.key === action.payload.providerKey);
		const teamId = providerAction ? ids.teams.get(providerAction.payload.teamKey) : null;
		if (!teamId || !providerId) throw new Error(`Missing provider for ${action.key}.`);
		const lane = await store.upsertCapacityProviderLane(teamId, providerId, {
			id: action.existing?.id,
			name: action.payload.name,
			businessModel: action.payload.businessModel ?? 'custom',
			modelFamily: action.payload.modelFamily,
			modelClass: action.payload.modelClass,
			regionPolicy: action.payload.regionPolicy,
			unit: action.payload.unit ?? 'treeseed_credit',
			scarcityLevel: action.payload.scarcityLevel ?? 'medium',
			hardLimits: action.payload.hardLimits ?? {},
			routingPolicy: action.payload.routingPolicy ?? {},
			metadata,
		});
		ids.lanes.set(action.key, lane.id);
		return lane;
	}
	if (action.kind === 'capacityGrant') {
		const teamId = ids.teams.get(action.payload.teamKey);
		const providerId = ids.providers.get(action.payload.providerKey);
		if (!teamId || !providerId) throw new Error(`Missing team or provider for ${action.key}.`);
		return store.upsertCapacityGrant(teamId, {
			id: action.existing?.id,
			capacityProviderId: providerId,
			laneId: action.payload.laneKey ? ids.lanes.get(action.payload.laneKey) ?? null : null,
			teamId,
			projectId: action.payload.projectKey ? ids.projects.get(action.payload.projectKey) ?? null : null,
			environment: action.payload.environment ?? null,
			grantScope: action.payload.grantScope ?? 'team',
			state: action.payload.state ?? 'active',
			dailyCreditLimit: action.payload.dailyCreditLimit,
			weeklyCreditLimit: action.payload.weeklyCreditLimit,
			monthlyCreditLimit: action.payload.monthlyCreditLimit,
			dailyUsdLimit: action.payload.dailyUsdLimit,
			weeklyQuotaMinutes: action.payload.weeklyQuotaMinutes,
			monthlyProviderUnits: action.payload.monthlyProviderUnits,
			portfolioAllocationPercent: action.payload.portfolioAllocationPercent,
			reservePoolPercent: action.payload.reservePoolPercent,
			maxDailyProjectCredits: action.payload.maxDailyProjectCredits,
			emergencyOverride: action.payload.emergencyOverride,
			priorityWeight: action.payload.priorityWeight ?? 1,
			overflowPolicy: action.payload.overflowPolicy ?? 'soft_grant',
			metadata,
		});
	}
	if (action.kind === 'workPolicy') {
		const projectId = ids.projects.get(action.payload.projectKey);
		if (!projectId) throw new Error(`Missing project for ${action.key}.`);
		return store.upsertProjectWorkPolicy(projectId, {
			environment: action.payload.environment,
			enabled: action.payload.enabled,
			startCron: action.payload.startCron,
			durationMinutes: action.payload.durationMinutes,
			maxRunners: action.payload.maxRunners,
			maxWorkersPerRunner: action.payload.maxWorkersPerRunner,
			dailyCreditBudget: action.payload.dailyCreditBudget,
			maxQueuedTasks: action.payload.maxQueuedTasks,
			maxQueuedCredits: action.payload.maxQueuedCredits,
			autoscale: action.payload.autoscale ?? {},
			creditWeights: action.payload.creditWeights ?? [],
			metadata,
		});
	}
	if (action.kind === 'product') {
		const teamId = ids.teams.get(action.payload.teamKey);
		if (!teamId) throw new Error(`Missing team for ${action.key}.`);
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
		if (!teamId || !productId) throw new Error(`Missing product for ${action.key}.`);
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

function seedRunInput({ plan, manifestHash, actor, state = 'running', result = undefined, error = undefined }) {
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

async function createSeedRunIfAvailable(store, input) {
	if (typeof store.createSeedRun !== 'function') return null;
	return store.createSeedRun(input);
}

async function updateSeedRunIfAvailable(store, runId, input) {
	if (!runId || typeof store.updateSeedRun !== 'function') return null;
	return store.updateSeedRun(runId, input);
}

function planApprovalMetadata(plan, manifestHash) {
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

function approvalMatchesPlan(approval, plan, manifestHash) {
	const seed = approval?.metadata?.seed;
	return Boolean(
		approval
		&& approval.state === 'approved'
		&& seed?.name === plan.seed
		&& seed?.version === plan.version
		&& seed?.manifestHash === manifestHash
		&& stableJson(seed?.environments ?? []) === stableJson(plan.environments)
		&& stableJson(seed?.planSummary ?? {}) === stableJson(plan.summary)
	);
}

function findApprovalAnchor(plan) {
	const preferred = plan.actions.find((action) => action.kind === 'project' && action.key === 'project:treeseed/market' && action.existing?.id);
	const project = preferred ?? plan.actions.find((action) => action.kind === 'project' && action.existing?.id);
	if (!project) return null;
	const teamAction = plan.actions.find((action) => action.key === project.payload.teamKey);
	if (!teamAction?.existing?.id) return null;
	return {
		projectId: project.existing.id,
		projectSlug: project.existing.slug ?? project.payload.slug,
		teamId: teamAction.existing.id,
		teamSlug: teamAction.existing.slug ?? teamAction.payload.slug,
	};
}

async function createProductionApproval({ store, plan, manifestHash, actor }) {
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

function registrationApiKeyPolicy(action) {
	const apiKey = action.payload?.registration?.apiKey;
	if (!apiKey || typeof apiKey !== 'object' || apiKey.createIfMissing !== true) return null;
	return apiKey;
}

function publicProviderKeyRecord(action, providerId, key, extra = {}) {
	return {
		providerId,
		providerKey: action.key,
		providerName: action.payload.name,
		keyId: key?.id ?? null,
		keyPrefix: key?.keyPrefix ?? null,
		...extra,
	};
}

function normalizedScopeList(scopes) {
	return Array.isArray(scopes)
		? [...new Set(scopes.map((scope) => String(scope ?? '').trim()).filter(Boolean))].sort()
		: [];
}

function scopeListsEqual(left, right) {
	const a = normalizedScopeList(left);
	const b = normalizedScopeList(right);
	return a.length === b.length && a.every((scope, index) => scope === b[index]);
}

async function ensureCapacityProviderApiKeys({ plan, store, ids, actor }) {
	const result = { created: [], existing: [], updated: [] };
	if (typeof store.listCapacityProviderApiKeys !== 'function' || typeof store.createCapacityProviderApiKey !== 'function') {
		return result;
	}
	for (const action of selectedActions(plan)) {
		if (action.kind !== 'capacityProvider') continue;
		const apiKey = registrationApiKeyPolicy(action);
		if (!apiKey) continue;
		const teamId = ids.teams.get(action.payload.teamKey);
		const providerId = ids.providers.get(action.key);
		if (!teamId || !providerId) continue;
		const activeKey = (await store.listCapacityProviderApiKeys(teamId, providerId))
			.find((key) => key.status === 'active' && !key.revokedAt) ?? null;
		if (activeKey) {
			const desiredScopes = Array.isArray(apiKey.scopes) && apiKey.scopes.length > 0 ? apiKey.scopes.map(String) : null;
			if (desiredScopes && !scopeListsEqual(activeKey.scopes, desiredScopes) && typeof store.updateCapacityProviderApiKeyScopes === 'function') {
				const updated = await store.updateCapacityProviderApiKeyScopes(teamId, providerId, activeKey.id, desiredScopes);
				if (updated) {
					result.updated.push(publicProviderKeyRecord(action, providerId, updated, {
						scopeReconciled: true,
					}));
					continue;
				}
			}
			result.existing.push(publicProviderKeyRecord(action, providerId, activeKey));
			continue;
		}
		const created = await store.createCapacityProviderApiKey(teamId, providerId, {
			name: typeof apiKey.name === 'string' && apiKey.name.trim() ? apiKey.name.trim() : 'Seed provider security code',
			plaintextKey: typeof apiKey.plaintextKey === 'string' && apiKey.plaintextKey.trim() ? apiKey.plaintextKey.trim() : undefined,
			scopes: Array.isArray(apiKey.scopes) && apiKey.scopes.length > 0 ? apiKey.scopes.map(String) : undefined,
			expiresAt: typeof apiKey.expiresAt === 'string' && apiKey.expiresAt.trim() ? apiKey.expiresAt.trim() : null,
			createdById: actorId(actor),
		});
		if (created?.key) {
			result.created.push(publicProviderKeyRecord(action, providerId, created.key, {
				plaintextKey: created.plaintextKey,
			}));
		}
	}
	return result;
}

function redactSeedApplyResult(result) {
	if (!result?.capacityProviderKeys) return result;
	return {
		...result,
		capacityProviderKeys: {
			...result.capacityProviderKeys,
			created: (result.capacityProviderKeys.created ?? []).map(({ plaintextKey: _plaintextKey, ...entry }) => entry),
		},
	};
}

function localBootstrapEmails(env = process.env) {
	return String(env.TREESEED_API_BOOTSTRAP_ADMIN_ALLOWLIST ?? '')
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}

async function findLocalSeedOwnerUser(store, env = process.env) {
	const allowlist = localBootstrapEmails(env);
	for (const email of allowlist) {
		const user = typeof store.findUserByEmail === 'function' ? await store.findUserByEmail(email) : null;
		if (user?.id) return user;
	}
	const users = typeof store.listActiveUsers === 'function' ? await store.listActiveUsers(2) : [];
	return users.length === 1 ? users[0] : null;
}

function seedActorUser(actor) {
	const principal = actor?.principal;
	if (!principal?.id || principal.roles?.includes?.('team_api_key') || principal.roles?.includes?.('project_api')) {
		return null;
	}
	return {
		id: principal.id,
		email: principal.metadata?.email ?? null,
	};
}

async function ensureLocalSeedTeamMemberships({ store, plan, ids, env, actor }) {
	if (!plan.environments.includes('local')) return [];
	const user = seedActorUser(actor) ?? await findLocalSeedOwnerUser(store, env);
	if (!user?.id) return [];
	const memberships = [];
	for (const action of selectedActions(plan).filter((entry) => entry.kind === 'team')) {
		const teamId = ids.teams.get(action.key) ?? action.existing?.id;
		if (!teamId) continue;
		const existing = await store.resolvePrincipalTeamContext(teamId, { id: user.id, roles: [] });
		if (existing?.membershipId) continue;
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
	const ids = { teams: new Map(), repositoryHosts: new Map(), projects: new Map(), providers: new Map(), lanes: new Map(), products: new Map(), productTeams: new Map() };
	const repairs = [];
	for (const action of selectedActions(planned.plan)) {
		if (action.existing?.id) {
			if (action.kind === 'team') ids.teams.set(action.key, action.existing.id);
			if (action.kind === 'repositoryHost') ids.repositoryHosts.set(action.key, action.existing.id);
			if (action.kind === 'project') ids.projects.set(action.key, action.existing.id);
			if (action.kind === 'capacityProvider') ids.providers.set(action.key, action.existing.id);
			if (action.kind === 'capacityLane') ids.lanes.set(action.key, action.existing.id);
			if (action.kind === 'product') {
				ids.products.set(action.key, action.existing.id);
				ids.productTeams.set(action.key, action.existing.teamId);
			}
		}
		await applyAction({ action, store, ids, manifestHash, appliedAt, plan: planned.plan });
		repairs.push(...await ensureProjectSeedDependencies({ action, store, ids, manifestHash, appliedAt }));
	}
	const capacityProviderKeys = await ensureCapacityProviderApiKeys({
		plan: planned.plan,
		store,
		ids,
		actor: input.actor,
	});
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
		capacityProviderKeys,
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

export async function exportSeedWithStore(input) {
	const diagnostics = [];
	const team = input.teamId
		? await input.store.getTeam(input.teamId)
		: input.team
			? await input.store.getTeamBySlug(input.team) ?? await input.store.getTeamByName(input.team)
			: null;
	if (!team) {
		return {
			ok: false,
			seed: input.name,
			manifest: null,
			yaml: '',
			diagnostics: [{
				severity: 'error',
				code: 'seed.export_team_missing',
				message: 'Team was not found for seed export.',
				path: 'team',
			}],
		};
	}
	const environments = normalizeExportEnvironments(input.environments);
	const teamKey = seededKey(team.metadata, generatedKey('team', team.slug ?? team.name));
	const manifest = {
		name: input.name ?? slugKey(team.slug ?? team.name),
		version: 1,
		description: `${team.displayName ?? team.name} exported seed bundle.`,
		defaultEnvironments: environments.includes('local') ? ['local'] : [environments[0]],
		environments,
		resources: {
			teams: [{
				key: teamKey,
				slug: team.slug,
				name: team.name,
				displayName: team.displayName,
				...(team.logoUrl ? { logoUrl: team.logoUrl } : {}),
				...(team.profileSummary ? { profileSummary: team.profileSummary } : {}),
				...(exportMetadata(team.metadata) ? { metadata: exportMetadata(team.metadata) } : {}),
			}],
			repositoryHosts: [],
			projects: [],
			hubRepositories: [],
			products: [],
			catalogArtifacts: [],
			capacityProviders: [],
			capacityGrants: [],
			workPolicies: [],
			agentPools: [],
		},
	};

	const repositoryHostKeyById = new Map();
	for (const host of (await input.store.listRepositoryHosts(team.id, { includePlatform: false })).sort(sortBy((host) => host.provider, (host) => host.name))) {
		const key = seededKey(host.metadata, generatedKey('repository-host', team.slug, host.provider, host.name));
		repositoryHostKeyById.set(host.id, key);
		const resource = {
			key,
			team: teamKey,
			provider: host.provider,
			name: host.name,
			ownership: host.ownership,
			organizationOrOwner: host.organizationOrOwner,
			defaultVisibility: host.defaultVisibility,
			status: host.status,
		};
		maybeAssign(resource, 'accountLabel', host.accountLabel);
		maybeAssign(resource, 'softwareRepositoryNameTemplate', host.softwareRepositoryNameTemplate);
		maybeAssign(resource, 'contentRepositoryNameTemplate', host.contentRepositoryNameTemplate);
		if (Object.keys(host.branchPolicy ?? {}).length > 0) resource.branchPolicy = host.branchPolicy;
		if (Object.keys(host.workflowPolicy ?? {}).length > 0) resource.workflowPolicy = host.workflowPolicy;
		if ((host.allowedProjectKinds ?? []).length > 0) resource.allowedProjectKinds = host.allowedProjectKinds;
		if (typeof host.metadata?.credentialRef === 'string') resource.credentialRef = host.metadata.credentialRef;
		const metadata = exportMetadata(host.metadata);
		if (metadata) resource.metadata = metadata;
		manifest.resources.repositoryHosts.push(resource);
	}

	const projects = (await input.store.listTeamProjects(team.id)).sort(sortBy((project) => project.slug));
	const projectKeyById = new Map();
	const chosenRepositoryRoleByProjectId = new Map();
	for (const project of projects) {
		const repositories = await input.store.listHubRepositories(project.id);
		const repository = repositories.find((entry) => ['primary', 'package', 'software', 'content'].includes(entry.role)) ?? repositories[0];
		if (!repository?.url) {
			diagnostics.push({ severity: 'warning', code: 'seed.export_project_without_repository', message: `Project ${project.slug} does not have a canonical repository URL and was skipped.`, path: `projects.${project.slug}` });
			continue;
		}
		const key = seededKey(project.metadata?.metadata, generatedKey('project', team.slug, project.slug));
		projectKeyById.set(project.id, key);
		chosenRepositoryRoleByProjectId.set(project.id, repository.role);
		const metadata = project.metadata?.metadata && typeof project.metadata.metadata === 'object' ? exportMetadata(project.metadata.metadata) : exportMetadata(project.metadata);
		const resource = {
			key,
			team: teamKey,
			slug: project.slug,
			name: project.name,
			description: project.description ?? undefined,
			kind: project.metadata?.kind ?? undefined,
			repository: {
				role: repository.role,
				provider: repository.provider,
				owner: repository.owner,
				name: repository.name,
				gitUrl: repository.url,
				defaultBranch: repository.defaultBranch ?? undefined,
				submodulePath: repository.submodulePath ?? undefined,
			},
			architecture: project.metadata?.architecture,
		};
		if (metadata) resource.metadata = metadata;
		manifest.resources.projects.push(resource);
	}

	for (const project of projects) {
		const projectKey = projectKeyById.get(project.id);
		if (!projectKey) continue;
		const repositories = (await input.store.listHubRepositories(project.id)).sort(sortBy((repository) => repository.role));
		for (const repository of repositories) {
			if (repository.role === chosenRepositoryRoleByProjectId.get(project.id)) continue;
			const resource = {
				key: seededKey(repository.metadata, generatedKey('hub-repository', team.slug, project.slug, repository.role)),
				project: projectKey,
				role: repository.role,
				provider: repository.provider,
				owner: repository.owner,
				name: repository.name,
				gitUrl: repository.url,
				defaultBranch: repository.defaultBranch ?? undefined,
				currentBranch: repository.currentBranch ?? undefined,
				status: repository.status ?? undefined,
			};
			if (repository.repositoryHostId && repositoryHostKeyById.has(repository.repositoryHostId)) resource.repositoryHost = repositoryHostKeyById.get(repository.repositoryHostId);
			maybeAssign(resource, 'submodulePath', repository.submodulePath);
			if (Object.keys(repository.accessPolicy ?? {}).length > 0) resource.accessPolicy = repository.accessPolicy;
			if (Object.keys(repository.releasePolicy ?? {}).length > 0) resource.releasePolicy = repository.releasePolicy;
			if (Object.keys(repository.publishPolicy ?? {}).length > 0) resource.publishPolicy = repository.publishPolicy;
			const metadata = exportMetadata(repository.metadata);
			if (metadata) resource.metadata = metadata;
			manifest.resources.hubRepositories.push(resource);
		}
	}

	const providers = (await input.store.listTeamCapacityProviders(team.id)).sort(sortBy((provider) => provider.name));
	const providerKeyById = new Map();
	const laneKeyById = new Map();
	for (const provider of providers) {
		const key = seededKey(provider.metadata, generatedKey('capacity-provider', team.slug, provider.name));
		providerKeyById.set(provider.id, key);
		const resource = {
			key,
			team: teamKey,
			name: provider.name,
			kind: providerManifestKind(provider),
			provider: provider.provider,
			billingScope: provider.billingScope,
			maxConcurrentWorkdays: provider.maxConcurrentWorkdays,
			maxConcurrentWorkers: provider.maxConcurrentWorkers,
			lanes: [],
		};
			maybeAssign(resource, 'creditBudgetMode', provider.creditBudgetMode ?? 'derived');
		if (Number(provider.monthlyCreditBudget ?? 0) > 0) resource.monthlyCreditBudget = provider.monthlyCreditBudget;
		if (Number(provider.dailyCreditBudget ?? 0) > 0) resource.dailyCreditBudget = provider.dailyCreditBudget;
		if (typeof input.store.listExecutionProviders === 'function') {
			const rawExecutionProviders = await input.store.listExecutionProviders(team.id, provider.id);
			const executionProviders = normalizeExecutionProviders(rawExecutionProviders, rawExecutionProviders);
			if (executionProviders.length > 0) resource.executionProviders = executionProviders;
		}
		const metadata = exportMetadata(provider.metadata);
		if (metadata) resource.metadata = metadata;
		for (const lane of (await input.store.listCapacityProviderLanes(team.id, provider.id)).sort(sortBy((lane) => lane.name))) {
			const laneKey = seededKey(lane.metadata, generatedKey('lane', team.slug, provider.name, lane.name));
			laneKeyById.set(lane.id, laneKey);
			const laneResource = {
				key: laneKey,
				name: lane.name,
				businessModel: lane.businessModel,
				modelFamily: lane.modelFamily,
				modelClass: lane.modelClass,
				regionPolicy: lane.regionPolicy,
				unit: lane.unit,
				scarcityLevel: lane.scarcityLevel,
			};
			if (Object.keys(lane.hardLimits ?? {}).length > 0) laneResource.hardLimits = lane.hardLimits;
			if (Object.keys(lane.routingPolicy ?? {}).length > 0) laneResource.routingPolicy = lane.routingPolicy;
			const laneMetadata = exportMetadata(lane.metadata);
			if (laneMetadata) laneResource.metadata = laneMetadata;
			resource.lanes.push(laneResource);
		}
		manifest.resources.capacityProviders.push(resource);
	}

	for (const grant of (await input.store.listCapacityGrants(team.id)).sort(sortBy((grant) => grant.environment, (grant) => grant.grantScope, (grant) => grant.projectId))) {
		const providerKey = providerKeyById.get(grant.capacityProviderId);
		if (!providerKey) continue;
		const projectKey = grant.projectId ? projectKeyById.get(grant.projectId) : undefined;
		const resource = {
			key: seededKey(grant.metadata, generatedKey('grant', team.slug, grant.environment ?? 'all', grant.grantScope ?? 'team', projectKey ?? 'team')),
			provider: providerKey,
			team: teamKey,
			grantScope: grant.grantScope,
			dailyCreditLimit: grant.dailyCreditLimit,
			weeklyCreditLimit: grant.weeklyCreditLimit,
			monthlyCreditLimit: grant.monthlyCreditLimit,
			dailyUsdLimit: grant.dailyUsdLimit,
			weeklyQuotaMinutes: grant.weeklyQuotaMinutes,
			monthlyProviderUnits: grant.monthlyProviderUnits,
			portfolioAllocationPercent: grant.portfolioAllocationPercent,
			reservePoolPercent: grant.reservePoolPercent,
			maxDailyProjectCredits: grant.maxDailyProjectCredits,
			emergencyOverride: grant.emergencyOverride,
			priorityWeight: grant.priorityWeight,
			overflowPolicy: grant.overflowPolicy,
			state: grant.state === 'active' ? undefined : grant.state,
		};
		if (grant.environment) resource.environment = grant.environment;
		if (grant.laneId && laneKeyById.has(grant.laneId)) resource.lane = laneKeyById.get(grant.laneId);
		if (projectKey) resource.project = projectKey;
		const metadata = exportMetadata(grant.metadata);
		if (metadata) resource.metadata = metadata;
		manifest.resources.capacityGrants.push(resource);
	}

	for (const project of projects) {
		const projectKey = projectKeyById.get(project.id);
		if (!projectKey) continue;
		for (const environment of environments) {
			const policy = await input.store.getProjectWorkPolicy(project.id, environment);
			if (!policy) continue;
			const resource = {
				key: seededKey(policy.metadata, generatedKey('work-policy', team.slug, environment, project.slug)),
				environments: [environment],
				project: projectKey,
				environment,
				enabled: policy.enabled,
				startCron: policy.startCron,
				durationMinutes: policy.durationMinutes,
				maxRunners: policy.maxRunners,
				maxWorkersPerRunner: policy.maxWorkersPerRunner,
				dailyCreditBudget: policy.dailyCreditBudget,
				maxQueuedTasks: policy.maxQueuedTasks,
				maxQueuedCredits: policy.maxQueuedCredits,
			};
			if (Object.keys(policy.autoscale ?? {}).length > 0) resource.autoscale = policy.autoscale;
			if ((policy.creditWeights ?? []).length > 0) resource.creditWeights = policy.creditWeights;
			const metadata = exportMetadata(policy.metadata);
			if (metadata) resource.metadata = metadata;
			manifest.resources.workPolicies.push(resource);
		}
	}

	const products = (await input.store.listTeamProducts(team.id, input.principal ?? null))
		.filter((product) => input.includePrivate === true || product.visibility === 'public')
		.sort(sortBy((product) => product.kind, (product) => product.slug));
	const productKeyById = new Map();
	for (const product of products) {
		const key = seededKey(product.metadata, generatedKey('product', team.slug, product.kind, product.slug));
		productKeyById.set(product.id, key);
		const resource = {
			key,
			team: teamKey,
			kind: product.kind,
			slug: product.slug,
			title: product.title,
			summary: product.summary ?? undefined,
			visibility: product.visibility,
			listingEnabled: product.listingEnabled,
			offerMode: product.offerMode,
			manifestKey: product.manifestKey ?? undefined,
			artifactKey: product.artifactKey ?? undefined,
			searchText: product.searchText ?? undefined,
		};
		const metadata = exportMetadata(product.metadata);
		if (metadata) resource.metadata = metadata;
		manifest.resources.products.push(resource);
	}

	if (input.includeArtifacts === true) {
		for (const product of products) {
			const productKey = productKeyById.get(product.id);
			if (!productKey) continue;
			for (const artifact of (await input.store.listCatalogArtifactVersions(product.id)).sort(sortBy((artifact) => artifact.version))) {
				const resource = {
					key: seededKey(artifact.metadata, generatedKey('catalog-artifact', team.slug, product.slug, artifact.version)),
					product: productKey,
					version: artifact.version,
					kind: artifact.kind,
					contentKey: artifact.contentKey,
					manifestKey: artifact.manifestKey ?? undefined,
					publishedAt: artifact.publishedAt ?? undefined,
				};
				const metadata = exportMetadata(artifact.metadata);
				if (metadata) resource.metadata = metadata;
				manifest.resources.catalogArtifacts.push(resource);
			}
		}
	}

	const cleanedManifest = pruneNullish(manifest);
	const yaml = YAML.stringify(cleanedManifest, { lineWidth: 0 });
	return {
		ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
		seed: cleanedManifest.name,
		manifest: cleanedManifest,
		yaml,
		diagnostics,
	};
}

export async function exportSeedFromCli(input) {
	const store = input.store ?? await createLocalSeedStore(input.projectRoot, input.env);
	return exportSeedWithStore({
		...input,
		store,
		name: input.seedName,
		team: input.team,
	});
}
