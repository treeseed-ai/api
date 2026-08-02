export function installFoundationUsersByUsernameItemProfileRoutes(context: any) {
	const { app, jsonError, store } = context;
	app.get('/v1/users/by-username/:username/profile', async (c) => {
					const profile = await store.loadUserProfileByUsername(c.req.param('username'), c.get('principal'));
					if (!profile) return jsonError(c, 404, 'Unknown user profile.');
					return c.json({ ok: true, payload: profile });
				});
}
