import { errorDiagnostic,warningDiagnostic } from '../errors.js';
import {
type SeedCatalogArtifactResource,
type SeedDiagnostic,
type SeedHubRepositoryResource,
type SeedManifest,
type SeedManifestResources,
type SeedOperationRecipe,
type SeedOperationRecipeStep,
type SeedProductResource,
type SeedProjectResource,
type SeedTeamMembershipResource,
type SeedCapacityProviderPrerequisite,
type SeedAgentLabServicePrincipalPrerequisite,
type SeedSupportRepositoryResource,
type SeedTeamResource,
} from '../types.js';
import { parseCatalogArtifact,parseHubRepository,parseOperationRecipe,parseProduct,parseProject,parseSupportRepository,walkForSecrets } from './parse-project.ts';
import { RESOURCE_BUCKETS,SUPPORTED_BUCKETS,asString,isRecord,parseEnvironments,parseTeam,parseTeamMembership,requireString,stringArrayField } from './resource-buckets.ts';

function parseCapacityProvider(value: unknown, index: number, diagnostics: SeedDiagnostic[]): SeedCapacityProviderPrerequisite | null {
	const path = `runtime.capacityProviders[${index}]`;
	if (!isRecord(value)) { diagnostics.push(errorDiagnostic('seed.invalid_runtime_prerequisite', 'Capacity provider prerequisite must be an object.', path)); return null; }
	const approval = asString(value.approval) || 'trusted-local-owner';
	const providerClass = asString(value.providerClass) || 'agent';
	const allowedModes = stringArrayField(value, 'allowedModes', path, diagnostics) ?? [];
	if (approval !== 'trusted-local-owner') diagnostics.push(errorDiagnostic('seed.invalid_provider_approval', 'Only trusted-local-owner approval is supported.', `${path}.approval`));
	if (providerClass !== 'agent' && providerClass !== 'platform-operation') diagnostics.push(errorDiagnostic('seed.invalid_provider_class', 'Provider class must be agent or platform-operation.', `${path}.providerClass`));
	if (allowedModes.some((mode) => mode !== 'planning' && mode !== 'acting')) diagnostics.push(errorDiagnostic('seed.invalid_provider_mode', 'Provider modes must be planning or acting.', `${path}.allowedModes`));
	return {
		key: requireString(value, 'key', path, diagnostics), providerClass: providerClass === 'platform-operation' ? 'platform-operation' : 'agent', environments: parseEnvironments(value.environments, `${path}.environments`, diagnostics),
		team: requireString(value, 'team', path, diagnostics), manifest: requireString(value, 'manifest', path, diagnostics),
		connectionId: requireString(value, 'connectionId', path, diagnostics), approval: 'trusted-local-owner',
		projects: stringArrayField(value, 'projects', path, diagnostics) ?? [],
		allowedModes: [...new Set(allowedModes)] as Array<'planning' | 'acting'>,
		executionProviderIds: stringArrayField(value, 'executionProviderIds', path, diagnostics) ?? [],
	};
}

function parseAgentLabServicePrincipal(value: unknown, index: number, diagnostics: SeedDiagnostic[]): SeedAgentLabServicePrincipalPrerequisite | null {
	const path = `runtime.agentLabServicePrincipals[${index}]`;
	if (!isRecord(value)) { diagnostics.push(errorDiagnostic('seed.invalid_runtime_prerequisite', 'Agent Lab service principal prerequisite must be an object.', path)); return null; }
	const roles = stringArrayField(value, 'roles', path, diagnostics) ?? [];
	if (roles.length !== 1 || roles[0] !== 'team_owner') diagnostics.push(errorDiagnostic('seed.invalid_agent_lab_service_principal_role', 'The local Agent Lab service principal must have exactly the team_owner role.', `${path}.roles`));
	return { key: requireString(value, 'key', path, diagnostics), environments: parseEnvironments(value.environments, `${path}.environments`, diagnostics), team: requireString(value, 'team', path, diagnostics), name: requireString(value, 'name', path, diagnostics), roles: ['team_owner'] };
}

export function arrayBucket(resources: Record<string, unknown>, bucket: string, diagnostics: SeedDiagnostic[]) {
	const value = resources[bucket];
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_resource_bucket', `resources.${bucket} must be an array.`, `resources.${bucket}`));
		return [];
	}
	if (!SUPPORTED_BUCKETS.has(bucket) && value.length > 0) {
		diagnostics.push(errorDiagnostic('seed.unsupported_resource_kind', `resources.${bucket} is recognized but is not backed by seed reconciliation yet.`, `resources.${bucket}`));
	}
	return value;
}

export function validateResourceKeys(manifest: SeedManifest, diagnostics: SeedDiagnostic[]) {
	const seen = new Map<string, string>();
	const visit = (key: string, path: string) => {
		if (!key) return;
		const existingPath = seen.get(key);
		if (existingPath) {
			diagnostics.push(errorDiagnostic('seed.duplicate_key', `Duplicate resource key ${key}; first seen at ${existingPath}.`, path));
			return;
		}
		seen.set(key, path);
	};
	manifest.resources.teams.forEach((team, index) => visit(team.key, `resources.teams[${index}].key`));
	manifest.resources.teamMemberships.forEach((member, index) => visit(member.key, `resources.teamMemberships[${index}].key`));
	manifest.resources.projects.forEach((project, index) => visit(project.key, `resources.projects[${index}].key`));
	manifest.resources.hubRepositories.forEach((repository, index) => visit(repository.key, `resources.hubRepositories[${index}].key`));
	manifest.resources.supportRepositories.forEach((repository, index) => visit(repository.key, `resources.supportRepositories[${index}].key`));
	manifest.resources.products.forEach((product, index) => visit(product.key, `resources.products[${index}].key`));
	manifest.resources.catalogArtifacts.forEach((artifact, index) => visit(artifact.key, `resources.catalogArtifacts[${index}].key`));
	manifest.runtime.capacityProviders.forEach((provider, index) => visit(provider.key, `runtime.capacityProviders[${index}].key`));
	manifest.runtime.agentLabServicePrincipals.forEach((principal, index) => visit(principal.key, `runtime.agentLabServicePrincipals[${index}].key`));
}

export function validateReferences(manifest: SeedManifest, diagnostics: SeedDiagnostic[]) {
	const teamKeys = new Set([...manifest.resources.teams.map((team) => team.key), ...manifest.references]);
	const projectKeys = new Set([...manifest.resources.projects.map((project) => project.key), ...manifest.references]);
	const productKeys = new Set([...manifest.resources.products.map((product) => product.key), ...manifest.references]);

	manifest.resources.projects.forEach((project, index) => {
		if (!teamKeys.has(project.team)) diagnostics.push(errorDiagnostic('seed.invalid_reference', `Unknown team reference: ${project.team}.`, `resources.projects[${index}].team`));
	});
	manifest.resources.teamMemberships.forEach((member, index) => {
		if (!teamKeys.has(member.team)) diagnostics.push(errorDiagnostic('seed.invalid_reference', `Unknown team reference: ${member.team}.`, `resources.teamMemberships[${index}].team`));
	});
	manifest.runtime.capacityProviders.forEach((provider, index) => {
		if (!teamKeys.has(provider.team)) diagnostics.push(errorDiagnostic('seed.invalid_reference', `Unknown team reference: ${provider.team}.`, `runtime.capacityProviders[${index}].team`));
		provider.projects.forEach((project, projectIndex) => { if (!projectKeys.has(project)) diagnostics.push(errorDiagnostic('seed.invalid_reference', `Unknown project reference: ${project}.`, `runtime.capacityProviders[${index}].projects[${projectIndex}]`)); });
		if (!(provider.environments ?? manifest.environments).every((environment) => environment === 'local')) diagnostics.push(errorDiagnostic('seed.provider_local_only', 'trusted-local-owner capacity prerequisites may target only local.', `runtime.capacityProviders[${index}].environments`));
	});
	manifest.runtime.agentLabServicePrincipals.forEach((principal, index) => {
		if (!teamKeys.has(principal.team)) diagnostics.push(errorDiagnostic('seed.invalid_reference', `Unknown team reference: ${principal.team}.`, `runtime.agentLabServicePrincipals[${index}].team`));
		if (!(principal.environments ?? manifest.environments).every((environment) => environment === 'local')) diagnostics.push(errorDiagnostic('seed.agent_lab_service_principal_local_only', 'Agent Lab service principals may target only local.', `runtime.agentLabServicePrincipals[${index}].environments`));
	});
	manifest.resources.hubRepositories.forEach((repository, index) => {
		if (!projectKeys.has(repository.project)) diagnostics.push(errorDiagnostic('seed.invalid_reference', `Unknown project reference: ${repository.project}.`, `resources.hubRepositories[${index}].project`));
	});
	manifest.resources.products.forEach((product, index) => {
		if (!teamKeys.has(product.team)) diagnostics.push(errorDiagnostic('seed.invalid_reference', `Unknown team reference: ${product.team}.`, `resources.products[${index}].team`));
	});
	manifest.resources.catalogArtifacts.forEach((artifact, index) => {
		if (!productKeys.has(artifact.product)) diagnostics.push(errorDiagnostic('seed.invalid_reference', `Unknown product reference: ${artifact.product}.`, `resources.catalogArtifacts[${index}].product`));
	});
}

export function allResourceKeys(manifest: SeedManifest) {
	return new Set([
		...manifest.resources.teams.map((team) => team.key),
		...manifest.resources.teamMemberships.map((member) => member.key),
		...manifest.resources.projects.map((project) => project.key),
		...manifest.resources.hubRepositories.map((repository) => repository.key),
		...manifest.resources.supportRepositories.map((repository) => repository.key),
		...manifest.resources.products.map((product) => product.key),
		...manifest.resources.catalogArtifacts.map((artifact) => artifact.key),
	]);
}

export function validateOperationRecipes(manifest: SeedManifest, diagnostics: SeedDiagnostic[]) {
	const recipeIds = new Map<string, string>();
	const resourceKeys = allResourceKeys(manifest);
	manifest.operationRecipes.forEach((recipe, recipeIndex) => {
		const recipePath = `operationRecipes[${recipeIndex}]`;
		const existingRecipePath = recipeIds.get(recipe.id);
		if (recipe.id && existingRecipePath) {
			diagnostics.push(errorDiagnostic('seed.recipe_duplicate_id', `Duplicate operation recipe id ${recipe.id}; first seen at ${existingRecipePath}.`, `${recipePath}.id`));
		}
		if (recipe.id) recipeIds.set(recipe.id, `${recipePath}.id`);
		if (recipe.environments.length === 0) {
			diagnostics.push(errorDiagnostic('seed.recipe_missing_environments', 'Operation recipe must target at least one environment.', `${recipePath}.environments`));
		}
		for (const environment of recipe.environments) {
			if (!manifest.environments.includes(environment)) {
				diagnostics.push(errorDiagnostic('seed.recipe_environment_not_declared', `Recipe environment ${environment} is not declared in environments.`, `${recipePath}.environments`));
			}
		}
		const steps = new Map<string, SeedOperationRecipeStep>();
		recipe.steps.forEach((step, stepIndex) => {
			const stepPath = `${recipePath}.steps[${stepIndex}]`;
			const existingStep = steps.get(step.id);
			if (step.id && existingStep) {
				diagnostics.push(errorDiagnostic('seed.recipe_duplicate_step_id', `Duplicate operation recipe step id ${step.id}.`, `${stepPath}.id`));
			}
			if (step.id) steps.set(step.id, step);
			step.uses.forEach((resourceKey, useIndex) => {
				if (!resourceKeys.has(resourceKey)) {
					diagnostics.push(errorDiagnostic('seed.recipe_invalid_resource_reference', `Unknown recipe resource reference: ${resourceKey}.`, `${stepPath}.uses[${useIndex}]`));
				}
			});
		});
		recipe.entrypoints.forEach((entrypoint, entrypointIndex) => {
			if (!steps.has(entrypoint)) {
				diagnostics.push(errorDiagnostic('seed.recipe_invalid_entrypoint', `Unknown recipe entrypoint step: ${entrypoint}.`, `${recipePath}.entrypoints[${entrypointIndex}]`));
			}
		});
		recipe.steps.forEach((step, stepIndex) => {
			step.dependsOn.forEach((dependency, dependencyIndex) => {
				if (!steps.has(dependency)) {
					diagnostics.push(errorDiagnostic('seed.recipe_invalid_dependency', `Unknown recipe dependency step: ${dependency}.`, `${recipePath}.steps[${stepIndex}].dependsOn[${dependencyIndex}]`));
				}
			});
		});
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (stepId: string, chain: string[]) => {
			if (visited.has(stepId)) return;
			if (visiting.has(stepId)) {
				diagnostics.push(errorDiagnostic('seed.recipe_cycle', `Recipe dependency cycle detected: ${[...chain, stepId].join(' -> ')}.`, recipePath));
				return;
			}
			const step = steps.get(stepId);
			if (!step) return;
			visiting.add(stepId);
			for (const dependency of step.dependsOn) {
				visit(dependency, [...chain, stepId]);
			}
			visiting.delete(stepId);
			visited.add(stepId);
		};
		for (const step of recipe.steps) {
			visit(step.id, []);
		}
	});
}

export function parseSeedManifest(value: unknown, diagnostics: SeedDiagnostic[]): SeedManifest | null {
	walkForSecrets(value, '', diagnostics);
	if (!isRecord(value)) {
		diagnostics.push(errorDiagnostic('seed.invalid_manifest', 'Seed manifest must be an object.', 'manifest'));
		return null;
	}
	const name = requireString(value, 'name', 'manifest', diagnostics);
	if (value.version !== 1) {
		diagnostics.push(errorDiagnostic('seed.unsupported_version', `Unsupported seed manifest version: ${String(value.version)}.`, 'version'));
	}
	const environments = parseEnvironments(value.environments, 'environments', diagnostics) ?? [];
	if (environments.length === 0) {
		diagnostics.push(errorDiagnostic('seed.missing_environments', 'Seed manifest must declare at least one environment.', 'environments'));
	}
	const defaultEnvironments = parseEnvironments(value.defaultEnvironments, 'defaultEnvironments', diagnostics);
	for (const environment of defaultEnvironments ?? []) {
		if (!environments.includes(environment)) {
			diagnostics.push(errorDiagnostic('seed.default_environment_not_declared', `Default environment ${environment} is not declared in environments.`, 'defaultEnvironments'));
		}
	}

	const resourcesValue = value.resources;
	if (!isRecord(resourcesValue)) {
		diagnostics.push(errorDiagnostic('seed.invalid_resources', 'Seed manifest resources must be an object.', 'resources'));
		return null;
	}
	for (const bucket of Object.keys(resourcesValue)) {
		if (!(RESOURCE_BUCKETS as readonly string[]).includes(bucket)) {
			diagnostics.push(errorDiagnostic('seed.unsupported_resource_kind', `Unsupported resource bucket: ${bucket}.`, `resources.${bucket}`));
		}
	}

	const resources: SeedManifestResources = {
		teams: arrayBucket(resourcesValue, 'teams', diagnostics).map((entry, index) => parseTeam(entry, `resources.teams[${index}]`, diagnostics)).filter((team): team is SeedTeamResource => Boolean(team)),
		teamMemberships: arrayBucket(resourcesValue, 'teamMemberships', diagnostics).map((entry, index) => parseTeamMembership(entry, `resources.teamMemberships[${index}]`, diagnostics)).filter((member): member is SeedTeamMembershipResource => Boolean(member)),
		projects: arrayBucket(resourcesValue, 'projects', diagnostics).map((entry, index) => parseProject(entry, `resources.projects[${index}]`, diagnostics)).filter((project): project is SeedProjectResource => Boolean(project)),
		hubRepositories: arrayBucket(resourcesValue, 'hubRepositories', diagnostics).map((entry, index) => parseHubRepository(entry, `resources.hubRepositories[${index}]`, diagnostics)).filter((repository): repository is SeedHubRepositoryResource => Boolean(repository)),
		supportRepositories: arrayBucket(resourcesValue, 'supportRepositories', diagnostics).map((entry, index) => parseSupportRepository(entry, `resources.supportRepositories[${index}]`, diagnostics)).filter((repository): repository is SeedSupportRepositoryResource => Boolean(repository)),
		products: arrayBucket(resourcesValue, 'products', diagnostics).map((entry, index) => parseProduct(entry, `resources.products[${index}]`, diagnostics)).filter((product): product is SeedProductResource => Boolean(product)),
		catalogArtifacts: arrayBucket(resourcesValue, 'catalogArtifacts', diagnostics).map((entry, index) => parseCatalogArtifact(entry, `resources.catalogArtifacts[${index}]`, diagnostics)).filter((artifact): artifact is SeedCatalogArtifactResource => Boolean(artifact)),
	};
	const runtimeValue = value.runtime === undefined ? {} : isRecord(value.runtime) ? value.runtime : {};
	if (value.runtime !== undefined && !isRecord(value.runtime)) diagnostics.push(errorDiagnostic('seed.invalid_runtime', 'runtime must be an object.', 'runtime'));
	for (const key of Object.keys(runtimeValue)) if (!['capacityProviders', 'agentLabServicePrincipals'].includes(key)) diagnostics.push(errorDiagnostic('seed.unsupported_runtime_kind', `Unsupported runtime prerequisite: ${key}.`, `runtime.${key}`));
	const capacityValues = runtimeValue.capacityProviders === undefined ? [] : Array.isArray(runtimeValue.capacityProviders) ? runtimeValue.capacityProviders : [];
	if (runtimeValue.capacityProviders !== undefined && !Array.isArray(runtimeValue.capacityProviders)) diagnostics.push(errorDiagnostic('seed.invalid_runtime_prerequisite', 'runtime.capacityProviders must be an array.', 'runtime.capacityProviders'));
	const principalValues = runtimeValue.agentLabServicePrincipals === undefined ? [] : Array.isArray(runtimeValue.agentLabServicePrincipals) ? runtimeValue.agentLabServicePrincipals : [];
	if (runtimeValue.agentLabServicePrincipals !== undefined && !Array.isArray(runtimeValue.agentLabServicePrincipals)) diagnostics.push(errorDiagnostic('seed.invalid_runtime_prerequisite', 'runtime.agentLabServicePrincipals must be an array.', 'runtime.agentLabServicePrincipals'));

	const manifest: SeedManifest = {
		name,
		version: 1,
		description: asString(value.description) || undefined,
		references: Array.isArray(value.references)
			? value.references.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry))
			: [],
		defaultEnvironments,
		environments,
		resources,
		runtime: {
			capacityProviders: capacityValues.map((entry, index) => parseCapacityProvider(entry, index, diagnostics)).filter((provider): provider is SeedCapacityProviderPrerequisite => Boolean(provider)),
			agentLabServicePrincipals: principalValues.map((entry, index) => parseAgentLabServicePrincipal(entry, index, diagnostics)).filter((principal): principal is SeedAgentLabServicePrincipalPrerequisite => Boolean(principal)),
		},
		operationRecipes: Array.isArray(value.operationRecipes)
			? value.operationRecipes.map((recipe, index) => parseOperationRecipe(recipe, `operationRecipes[${index}]`, diagnostics, environments)).filter((recipe): recipe is SeedOperationRecipe => Boolean(recipe))
			: [],
	};
	if (value.references !== undefined && !Array.isArray(value.references)) {
		diagnostics.push(errorDiagnostic('seed.invalid_references', 'references must be an array of stable resource keys.', 'references'));
	}
	if (value.operationRecipes !== undefined && !Array.isArray(value.operationRecipes)) {
		diagnostics.push(errorDiagnostic('seed.invalid_operation_recipes', 'operationRecipes must be an array.', 'operationRecipes'));
	}
	validateResourceKeys(manifest, diagnostics);
	validateReferences(manifest, diagnostics);
	validateOperationRecipes(manifest, diagnostics);
	if (diagnostics.length === 0 && manifest.resources.projects.length === 0
		&& manifest.runtime.capacityProviders.length === 0 && manifest.runtime.agentLabServicePrincipals.length === 0) {
		diagnostics.push(warningDiagnostic('seed.empty_projects', 'Seed manifest does not define projects.', 'resources.projects'));
	}
	return manifest;
}
