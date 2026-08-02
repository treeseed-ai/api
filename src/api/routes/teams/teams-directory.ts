export function installTeamsDirectoryRoutes(context: any) {
	const { app, ensurePrincipal, isLocalAcceptanceServicePrincipal, jsonError, store } = context;
	app.get('/v1/teams', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (isLocalAcceptanceServicePrincipal(c, auth.principal)) {
						const rows = await store.all(
							`SELECT id FROM teams
							 WHERE name LIKE 'capacity-live-acceptance-%'
							    OR name LIKE 'capacity-live-governance-%'
							 ORDER BY created_at ASC`,
						);
						const teams = (await Promise.all(rows.map((row: { id?: unknown }) => store.getTeam(String(row.id ?? '')))))
							.filter((team: any) => team?.metadata?.liveAcceptance === true);
						return c.json({ ok: true, payload: teams });
					}
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
