export function installFoundationCurrentUserMarketsRoutes(context: any) {
	const { app, config, ensurePrincipal, marketProfilesForTeams, runtime, store } = context;
	app.get('/v1/me', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const teams = await store.listTeamsForPrincipal(auth.principal);
					return c.json({
						ok: true,
						payload: {
							principal: auth.principal,
							teams,
						},
					});
				});
	
	app.get('/v1/me/markets', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const teams = await store.listTeamsForPrincipal(auth.principal);
					return c.json({
						ok: true,
						payload: marketProfilesForTeams(teams, runtime.resolved.config.baseUrl),
					});
				});
}
