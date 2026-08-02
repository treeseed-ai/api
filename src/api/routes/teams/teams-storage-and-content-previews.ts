export function installTeamsStorageAndContentPreviewsRoutes(context: any) {
	const { app, config, jsonError, requireTeamAccess, runtime, signEditorialPreviewToken, store } = context;
	app.get('/v1/teams/:teamId/storage', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getTeamStorageLocator(c.req.param('teamId')),
					});
				});
	
	app.put('/v1/teams/:teamId/storage', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.bucketName || !body.manifestKeyTemplate || !body.previewRootTemplate) {
						return jsonError(c, 400, 'bucketName, manifestKeyTemplate, and previewRootTemplate are required.');
					}
					return c.json({
						ok: true,
						payload: await store.upsertTeamStorageLocator(c.req.param('teamId'), {
							bucketName: String(body.bucketName),
							manifestKeyTemplate: String(body.manifestKeyTemplate),
							previewRootTemplate: String(body.previewRootTemplate),
							publicBaseUrl: typeof body.publicBaseUrl === 'string' ? body.publicBaseUrl : null,
							metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
						}),
					});
				});
	
	app.post('/v1/teams/:teamId/content-previews', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.previewId) {
						return jsonError(c, 400, 'previewId is required.');
					}
					const expiresAt = typeof body.expiresAt === 'string'
						? body.expiresAt
						: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
					const secret = String(runtime.env?.TREESEED_EDITORIAL_PREVIEW_SECRET ?? runtime.resolved.config.authSecret ?? '');
					if (!secret) {
						return jsonError(c, 500, 'Editorial preview secret is not configured.');
					}
					const token = signEditorialPreviewToken({
						teamId: c.req.param('teamId'),
						previewId: String(body.previewId),
						expiresAt,
					}, secret);
					return c.json({
						ok: true,
						payload: {
							teamId: c.req.param('teamId'),
							previewId: String(body.previewId),
							expiresAt,
							token,
							previewUrl: `${runtime.resolved.config.baseUrl ?? ''}?preview=${encodeURIComponent(token)}`,
						},
					});
				});
}
