export function installTeamsDirectoryRoutes(context: any) {
	const { app, ensurePrincipal, jsonError, store } = context;
	app.get('/v1/teams', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					return c.json({
						ok: true,
						payload: await store.listTeamsForPrincipal(auth.principal),
					});
				});
	
	app.get('/v1/teams/by-name/:name/profile', async (c) => {
					const profile = await store.loadTeamProfileByName(c.req.param('name'), c.get('principal'));
					if (!profile) return jsonError(c, 404, 'Unknown team profile.');
					return c.json({ ok: true, payload: profile });
				});
}
