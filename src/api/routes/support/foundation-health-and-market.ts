export function installFoundationHealthAndMarketRoutes(context: any) {
	const { app, bearerTokenFromRequest, capacity, centralMarketProfile, config, installCapacityRoutes, localAcceptanceAdminToken, localAcceptanceAuthEnabled, requireProjectAccess, requireTeamAccess, runtime, runtimeMarketAuthProvider, store } = context;
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
		if (!c.get('principal')) {
			const token = bearerTokenFromRequest(c.req.raw);
			if (token) {
				const match = await store.authenticateTeamApiKey(token);
				if (match) {
					c.set('principal', match.principal);
					c.set('credential', { type: 'team_api_key', id: match.keyId, label: 'Team API Key' });
					c.set('actorType', 'service');
					c.set('permissionGrants', match.principal.permissions);
				}
			}
		}
		if (!c.get('principal') && localAcceptanceAuthEnabled(runtime)) {
			const token = bearerTokenFromRequest(c.req.raw);
			if (token && token === localAcceptanceAdminToken()) {
				const requestedTeam = c.req.param?.('teamId') || c.req.query?.('teamId') || process.env.TREESEED_CAPACITY_ACCEPTANCE_TEAM_ID || 'treeseed';
				const team = await store.getTeam(requestedTeam).catch(() => null) ?? await store.getTeamBySlug(requestedTeam).catch(() => null) ?? await store.getTeamBySlug('treeseed').catch(() => null);
				const principal = { id: 'team-key:local-capacity-acceptance', displayName: 'Local Capacity Acceptance', roles: ['team_api_key', 'market_admin'], permissions: ['*:*:*', 'seeds:apply:global', 'teams:manage:team'], scopes: ['auth:me'], metadata: { teamId: team?.id ?? null, teamName: team?.name ?? requestedTeam, teamDisplayName: team?.displayName ?? team?.name ?? requestedTeam, localAcceptance: true } };
				c.set('principal', principal); c.set('credential', { type: 'team_api_key', id: 'local-capacity-acceptance', label: 'Local Capacity Acceptance' }); c.set('actorType', 'service'); c.set('permissionGrants', principal.permissions);
			}
		}
		await next();
	});
	installCapacityRoutes(app, { store: capacity, requireTeamAccess, requireProjectAccess, runtime, runtimeMarketAuthProvider, config: { ...config, ...runtime.resolved.config } });
	app.get('/v1/markets/current', async (c: any) => c.json({ ok: true, payload: centralMarketProfile(runtime.resolved.config.baseUrl) }));
}
