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

async function resolveResource(store: any, key: string) {
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

export function installSeedResourceResolutionRoutes(context: any) {
	const { app, ensurePrincipal, jsonError, principalIsSeedAdmin, store } = context;
	app.post('/v1/seeds/resources/resolve', async (c: any) => {
		const auth = await ensurePrincipal(c);
		if (auth.response) return auth.response;
		if (!principalIsSeedAdmin(auth.principal)) {
			return jsonError(c, 403, 'Seed resource resolution requires seed administration access.');
		}
		const body = await c.req.json().catch(() => ({}));
		const keys = Array.isArray(body.keys)
			? [...new Set(body.keys.map(text).filter((value): value is string => Boolean(value)))]
			: [];
		if (keys.length === 0 || keys.length > 500) {
			return jsonError(c, 400, 'keys must contain between 1 and 500 stable seed resource keys.');
		}
		const resources = await Promise.all(keys.map((key) => resolveResource(store, key)));
		const unresolved = keys.filter((_, index) => !resources[index]);
		if (unresolved.length > 0) {
			return c.json({ ok: false, error: 'One or more seed resources are unresolved.', unresolved }, { status: 409 });
		}
		return c.json({ ok: true, payload: resources });
	});
}
