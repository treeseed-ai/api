import { resolveSeedResource } from '../../../market/seeds/apply.js';

function text(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
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
		const resources = await Promise.all(keys.map((key) => resolveSeedResource(store, key)));
		const unresolved = keys.filter((_, index) => !resources[index]);
		if (unresolved.length > 0) {
			return c.json({ ok: false, error: 'One or more seed resources are unresolved.', unresolved }, { status: 409 });
		}
		return c.json({ ok: true, payload: resources });
	});
}
