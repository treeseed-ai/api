export function installFoundationCurrentUserRoutes(context: any) {
	const { app, ensurePrincipal, store } = context;
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
}
