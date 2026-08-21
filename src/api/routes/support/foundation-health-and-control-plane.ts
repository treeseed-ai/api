export function installFoundationHealthAndControlPlaneRoutes(context: any) {
	const { app, bearerTokenFromRequest, capacity, config, installCapacityRoutes, requireProjectAccess, requireTeamAccess, runtime, runtimeControlPlaneAuthProvider, sessionEvents, store } = context;
	app.get('/healthz/deep', async (c: any) => {
		try {
			await store.ensureInitialized();
			const probe = await store.first('SELECT 1 AS ok');
			return c.json({ ok: true, status: 'ok', checks: { database: probe?.ok === 1 || probe?.ok === '1' } });
		} catch (error) {
			return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
		}
	});
	app.use('/v1/*', async (c: any, next: any) => {
		const token = bearerTokenFromRequest(c.req.raw);
		if (!c.get('principal') && token) {
				const match = await store.authenticateTeamApiKey(token);
				if (match) {
					c.set('principal', match.principal);
					c.set('credential', { type: 'team_api_key', id: match.keyId, label: 'Team API Key' });
					c.set('actorType', 'service');
					c.set('permissionGrants', match.principal.permissions);
				}
		}
		await next();
	});
	installCapacityRoutes(app, { store: capacity, requireTeamAccess, requireProjectAccess, runtime, runtimeControlPlaneAuthProvider, sessionEvents, config: { ...config, ...runtime.resolved.config } });
}
