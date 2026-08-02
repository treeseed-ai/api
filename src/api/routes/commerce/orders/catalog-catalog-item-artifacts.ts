export function installCatalogCatalogItemArtifactsRoutes(context: any) {
	const { app, jsonError, requireCatalogItemAccess, store } = context;
	app.post('/v1/catalog/:itemId/artifacts', async (c) => {
					const access = await requireCatalogItemAccess(c, store, c.req.param('itemId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.kind || !body.version || !body.contentKey) {
						return jsonError(c, 400, 'kind, version, and contentKey are required.');
					}
					return c.json({
						ok: true,
						payload: await store.upsertCatalogArtifactVersion(access.item.teamId, access.item.id, {
							id: typeof body.id === 'string' ? body.id : undefined,
							kind: String(body.kind),
							version: String(body.version),
							contentKey: String(body.contentKey),
							manifestKey: typeof body.manifestKey === 'string' ? body.manifestKey : null,
							metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
							publishedAt: typeof body.publishedAt === 'string' ? body.publishedAt : null,
						}),
					});
				});
}
