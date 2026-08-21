import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateSeedSource, type SeedDiagnostic, type SeedEnvironment, type SeedPlan, type SeedPlanAction } from '@treeseed/sdk/seeds';

const error = (code: string, message: string, path?: string): SeedDiagnostic => ({ severity: 'error', code, message, path });
const hasErrors = (diagnostics: SeedDiagnostic[]) => diagnostics.some((diagnostic) => diagnostic.severity === 'error');
const ownership = (manifest: any, resourceKey: string) => ({ seed: { name: manifest.name, resourceKey, version: manifest.version } });
const metadata = (manifest: any, resourceKey: string, value: Record<string, unknown> | undefined) => ({ ...(value ?? {}), ...ownership(manifest, resourceKey) });

function selectedEnvironments(resource: any, manifest: any, selected: SeedEnvironment[]) {
	const declared = resource.environments?.length ? resource.environments : manifest.environments;
	return declared.filter((environment: SeedEnvironment) => selected.includes(environment));
}

function normalizeCoreResources(manifest: any, selected: SeedEnvironment[]) {
	const resources: Array<Omit<SeedPlanAction, 'action'>> = [];
	for (const team of manifest.resources.teams) {
		resources.push({
			kind: 'team', key: team.key, label: team.displayName ?? team.name ?? team.slug,
			environments: selectedEnvironments(team, manifest, selected),
			payload: {
				slug: team.slug, name: team.name ?? team.slug, displayName: team.displayName ?? team.name ?? team.slug,
				logoUrl: team.logoUrl ?? null, profileSummary: team.profileSummary ?? null,
				metadata: metadata(manifest, team.key, team.metadata),
			},
		});
	}
	for (const member of manifest.resources.teamMemberships) {
		resources.push({
			kind: 'teamMembership', key: member.key, label: member.email,
			environments: selectedEnvironments(member, manifest, selected),
			payload: {
				teamKey: member.team, email: member.email, roles: member.roles, missingUser: member.missingUser,
				metadata: ownership(manifest, member.key),
			},
		});
	}
	for (const project of manifest.resources.projects) {
		resources.push({
			kind: 'project', key: project.key, label: `${project.team.replace(/^team:/u, '')}/${project.slug}`,
			environments: selectedEnvironments(project, manifest, selected),
			payload: {
				teamKey: project.team, slug: project.slug, name: project.name, description: project.description ?? null,
				kind: project.kind ?? null, repository: project.repository, architecture: project.architecture,
				metadata: metadata(manifest, project.key, project.metadata),
			},
		});
	}
	for (const repository of manifest.resources.hubRepositories) {
		resources.push({
			kind: 'hubRepository', key: repository.key,
			label: `${repository.project.replace(/^project:/u, '')}/${repository.role}`,
			environments: selectedEnvironments(repository, manifest, selected),
			payload: {
				projectKey: repository.project, role: repository.role, provider: repository.provider,
				owner: repository.owner, name: repository.name, gitUrl: repository.gitUrl,
				defaultBranch: repository.defaultBranch ?? null,
				currentBranch: repository.currentBranch ?? repository.defaultBranch ?? null,
				submodulePath: repository.submodulePath ?? null, status: repository.status ?? 'active',
				accessPolicy: repository.accessPolicy ?? null, releasePolicy: repository.releasePolicy ?? null,
				publishPolicy: repository.publishPolicy ?? null, repositoryPolicy: repository.repositoryPolicy ?? null,
				metadata: metadata(manifest, repository.key, repository.metadata),
			},
		});
	}
	return resources;
}

function selectEnvironments(manifest: any, requested: string | undefined) {
	const errors: string[] = [];
	const raw = requested ? requested.split(',').map((entry) => entry.trim()).filter(Boolean)
		: manifest.defaultEnvironments?.length ? manifest.defaultEnvironments : ['local'];
	const environments: SeedEnvironment[] = [];
	for (const value of raw) {
		if (!['local', 'staging', 'prod'].includes(value)) errors.push(`Unknown seed environment: ${value}.`);
		else if (!manifest.environments.includes(value)) errors.push(`Seed ${manifest.name} does not declare environment: ${value}.`);
		else if (!environments.includes(value as SeedEnvironment)) environments.push(value as SeedEnvironment);
	}
	if (!environments.length && !errors.length) errors.push('No seed environments selected.');
	return { environments, errors };
}

function orderedSteps(recipe: any) {
	const byId = new Map(recipe.steps.map((step: any) => [step.id, step]));
	const ordered: any[] = [];
	const visited = new Set<string>();
	const visit = (step: any) => {
		if (visited.has(step.id)) return;
		for (const dependency of step.dependsOn) {
			const dependencyStep = byId.get(dependency);
			if (dependencyStep) visit(dependencyStep);
		}
		visited.add(step.id);
		ordered.push(step);
	};
	for (const step of recipe.steps) visit(step);
	return ordered;
}

function createPlan(manifest: any, manifestPath: string, environments: SeedEnvironment[], mode: SeedPlan['mode'], diagnostics: SeedDiagnostic[]) {
	const actions = normalizeCoreResources(manifest, environments).map((resource): SeedPlanAction => resource.environments.length === 0
		? { ...resource, action: 'skip', reason: 'Resource does not target the selected environments.' }
		: { ...resource, action: 'create' });
	const summary = { create: 0, update: 0, unchanged: 0, skip: 0, delete: 0, error: 0 };
	for (const action of actions) summary[action.action] += 1;
	return {
		ok: !hasErrors(diagnostics), seed: manifest.name, version: manifest.version,
		references: [...(manifest.references ?? [])], mode, environments, summary, actions,
		runtime: {
			capacityProviders: manifest.runtime.capacityProviders.filter((provider: any) =>
				(provider.environments?.length ? provider.environments : manifest.environments).some((environment: SeedEnvironment) => environments.includes(environment))),
			agentLabServicePrincipals: manifest.runtime.agentLabServicePrincipals.filter((principal: any) =>
				(principal.environments?.length ? principal.environments : manifest.environments).some((environment: SeedEnvironment) => environments.includes(environment))),
		},
		recipes: manifest.operationRecipes.map((recipe: any) => {
			const selected = recipe.environments.some((environment: SeedEnvironment) => environments.includes(environment));
			return { ...recipe, selected, orderedSteps: selected ? orderedSteps(recipe) : [] };
		}),
		diagnostics, manifestPath,
	} satisfies SeedPlan;
}

export function loadAndPlanCoreSeed(input: { projectRoot: string; seedName: string; environments?: string; mode: SeedPlan['mode'] }) {
	const manifestPath = resolve(input.projectRoot, 'seeds', `${input.seedName}.yaml`);
	const diagnostics: SeedDiagnostic[] = [];
	if (!/^[a-z0-9][a-z0-9._-]*$/u.test(input.seedName)) {
		diagnostics.push(error('seed.invalid_name', `Seed name must be a simple file-safe identifier: ${input.seedName}.`, 'name'));
	} else if (!existsSync(manifestPath)) {
		diagnostics.push(error('seed.not_found', `Seed manifest not found at ${manifestPath}.`, 'manifest'));
	}
	if (diagnostics.length) return { ok: false, plan: null, diagnostics, manifestPath };
	const validated = validateSeedSource(readFileSync(manifestPath, 'utf8'));
	diagnostics.push(...validated.diagnostics);
	const manifest = validated.manifest as any;
	if (!manifest) return { ok: false, plan: null, diagnostics, manifestPath };
	if (manifest.name !== input.seedName) diagnostics.push(error('seed.name_mismatch', `Manifest name ${manifest.name} does not match requested seed ${input.seedName}.`, 'name'));
	if (manifest.resources.products.length || manifest.resources.catalogArtifacts.length) {
		diagnostics.push(error('seed.unsupported_commerce_resource', 'Core control-plane seeds cannot contain products or catalog artifacts.', 'resources'));
	}
	const selected = selectEnvironments(manifest, input.environments);
	for (const message of selected.errors) diagnostics.push(error('seed.environment_selection', message, 'environments'));
	if (hasErrors(diagnostics)) return { ok: false, plan: null, diagnostics, manifestPath };
	return { ok: true, plan: createPlan(manifest, manifestPath, selected.environments, input.mode, diagnostics), diagnostics, manifestPath };
}
