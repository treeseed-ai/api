function text(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function resourceKey(value: unknown) {
	const metadata = object(object(value).metadata);
	const direct = object(metadata.seed);
	const nested = object(object(metadata.metadata).seed);
	return text(direct.resourceKey) ?? text(nested.resourceKey);
}

export async function resolveSeedResource(store: any, key: string) {
	if (key.startsWith('team:')) {
		const slug = key.slice('team:'.length);
		const team = slug ? await store.getTeamBySlug(slug) : null;
		return team && resourceKey(team) === key
			? { key, kind: 'team', id: team.id, teamId: team.id, slug: team.slug }
			: null;
	}
	if (key.startsWith('project:')) {
		const identity = key.slice('project:'.length);
		const separator = identity.indexOf('/');
		const teamSlug = separator > 0 ? identity.slice(0, separator) : '';
		const projectSlug = separator > 0 ? identity.slice(separator + 1) : '';
		const team = teamSlug ? await store.getTeamBySlug(teamSlug) : null;
		const project = team?.id && projectSlug
			? await store.getProjectByTeamAndSlug(team.id, projectSlug)
			: null;
		return project && resourceKey(project) === key
			? { key, kind: 'project', id: project.id, teamId: team.id, slug: project.slug }
			: null;
	}
	return null;
}

export async function resolveSeedReferences(store: any, keys: string[]) {
	const resources = await Promise.all(keys.map((key) => resolveSeedResource(store, key)));
	const unresolved = keys.filter((_, index) => !resources[index]);
	if (unresolved.length > 0) {
		throw new Error(`Seed references are unresolved: ${unresolved.join(', ')}.`);
	}
	return resources.filter((resource): resource is NonNullable<typeof resource> => Boolean(resource));
}

export function addSeedReferencesToIds(ids: any, resources: Awaited<ReturnType<typeof resolveSeedReferences>>) {
	for (const resource of resources) {
		if (resource.kind === 'team') ids.teams.set(resource.key, resource.id);
		if (resource.kind === 'project') {
			ids.projects.set(resource.key, resource.id);
			ids.projectTeams.set(resource.key, resource.teamId);
		}
	}
}
