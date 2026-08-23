import {
	digestSeedBundle,
	validateSeedBundle,
	type SeedBundleV2,
} from '@treeseed/sdk/operator-contracts';

const ownership = (bundle: SeedBundleV2, resourceKey: string) => ({
	seed: { name: bundle.name, resourceKey, version: bundle.version },
});

function selectedEnvironments(bundle: SeedBundleV2, requested?: string) {
	const selected = requested
		? requested.split(',').map((entry) => entry.trim()).filter(Boolean)
		: bundle.environments.includes('local') ? ['local'] : [...bundle.environments];
	const unknown = selected.filter((environment) => !bundle.environments.includes(environment));
	return { selected: [...new Set(selected)], unknown };
}

export async function planPortableSeedBundle(input: {
	bundle: SeedBundleV2;
	seedName: string;
	environments?: string;
	mode: 'plan' | 'apply';
}) {
	const { bundle } = input;
	const diagnostics = validateSeedBundle(bundle).map((diagnostic) => ({ severity: 'error', ...diagnostic }));
	if (bundle.name !== input.seedName) diagnostics.push({
		severity: 'error', code: 'seed_bundle_name_mismatch', path: 'name',
		message: `Bundle name ${bundle.name} does not match requested seed ${input.seedName}.`,
	});
	const computedDigest = await digestSeedBundle(bundle);
	if (computedDigest !== bundle.digest) diagnostics.push({
		severity: 'error', code: 'seed_bundle_digest_mismatch', path: 'digest',
		message: 'The supplied seed digest does not match its canonical bundle content.',
	});
	const environments = selectedEnvironments(bundle, input.environments);
	for (const environment of environments.unknown) diagnostics.push({
		severity: 'error', code: 'seed_bundle_environment_unknown', path: 'environments',
		message: `Seed ${bundle.name} does not declare environment ${environment}.`,
	});
	if (diagnostics.length) return {
		ok: false, plan: null, diagnostics, manifestPath: `bundle:${bundle.digest}`, manifestHash: bundle.digest,
	};

	const repositories = new Map(bundle.resources.repositories.map((repository) => [repository.key, repository]));
	const actions: any[] = [];
	for (const team of bundle.resources.teams) actions.push({
		kind: 'team', key: team.key, label: team.displayName,
		environments: environments.selected, action: 'create',
		payload: { ...team, logoUrl: null, profileSummary: team.profileSummary ?? null, metadata: ownership(bundle, team.key) },
	});
	for (const membership of bundle.resources.memberships) actions.push(membership.principal.kind === 'user' ? {
		kind: 'teamMembership', key: membership.key, label: membership.principal.email,
		environments: environments.selected, action: 'create',
		payload: { teamKey: membership.team, email: membership.principal.email, roles: membership.roles,
			missingUser: membership.missingUser, metadata: ownership(bundle, membership.key) },
	} : {
		kind: 'servicePrincipalMembership', key: membership.key, label: membership.principal.displayName,
		environments: environments.selected, action: 'create',
		payload: { teamKey: membership.team, principalKey: membership.principal.key,
			displayName: membership.principal.displayName, interactiveLogin: false,
			roles: membership.roles, metadata: ownership(bundle, membership.key) },
	});
	for (const project of bundle.resources.projects) {
		const primary = project.primaryRepository ? repositories.get(project.primaryRepository) : undefined;
		actions.push({
			kind: 'project', key: project.key, label: `${project.team.replace(/^team:/u, '')}/${project.slug}`,
			environments: environments.selected, action: 'create',
			payload: { teamKey: project.team, slug: project.slug, name: project.name,
				description: project.description, kind: project.kind,
				repository: primary ? { role: primary.role, provider: primary.provider, owner: primary.owner, name: primary.name,
					gitUrl: primary.gitUrl, defaultBranch: primary.defaultBranch, repositoryPolicy: primary.repositoryPolicy,
					submodulePath: primary.submodulePath ?? primary.checkoutPath ?? null } : null,
				architecture: project.metadata?.architecture ?? {},
				metadata: { ...(project.metadata ?? {}), ...ownership(bundle, project.key) } },
		});
	}
	for (const repository of bundle.resources.repositories) actions.push({
		kind: 'hubRepository', key: repository.key, label: `${repository.project.replace(/^project:/u, '')}/${repository.role}`,
		environments: environments.selected, action: 'create',
		payload: { projectKey: repository.project, role: repository.role, provider: repository.provider,
			owner: repository.owner, name: repository.name, gitUrl: repository.gitUrl,
			defaultBranch: repository.defaultBranch,
			submodulePath: repository.submodulePath ?? repository.checkoutPath ?? null, status: 'active',
			accessPolicy: {}, releasePolicy: {}, publishPolicy: {}, repositoryPolicy: repository.repositoryPolicy,
			metadata: { ...(repository.metadata ?? {}), ...ownership(bundle, repository.key) } },
	});

	const summary = { create: actions.length, update: 0, unchanged: 0, skip: 0, delete: 0, error: 0 };
	return {
		ok: true,
		manifestPath: `bundle:${bundle.digest}`,
		manifestHash: bundle.digest,
		diagnostics,
		plan: {
			ok: true, seed: bundle.name, version: bundle.version, references: [], mode: input.mode,
			environments: environments.selected, summary, actions,
			runtime: { capacityProviders: bundle.runtime.capacityProviders }, recipes: [], diagnostics,
			manifestPath: `bundle:${bundle.digest}`,
		},
	};
}
