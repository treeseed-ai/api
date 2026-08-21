export function installFoundationHealthAndControlPlaneRoutes(context: any) {
	const { app, bearerTokenFromRequest, capacity, config, installCapacityRoutes, requireProjectAccess, requireTeamAccess, runtime, runtimeControlPlaneAuthProvider, sessionEvents, store } = context;
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
