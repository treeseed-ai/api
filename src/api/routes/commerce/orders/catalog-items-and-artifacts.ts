export function installCatalogItemsAndArtifactsRoutes(context: any) {
	const { app, artifactDownloadPayload, config, jsonError, runtime, store } = context;
	app.get('/v1/catalog', async (c) => {
					const kind = typeof c.req.query('kind') === 'string' ? c.req.query('kind') : undefined;
					const teamId = typeof c.req.query('teamId') === 'string' ? c.req.query('teamId') : undefined;
					const slug = typeof c.req.query('slug') === 'string' ? c.req.query('slug') : undefined;
					return c.json({
						ok: true,
						payload: await store.listCatalogItems(c.get('principal'), {
							kind,
							teamId,
							slug,
						}),
					});
				});
	
	app.get('/v1/catalog/:itemId', async (c) => {
					const item = await store.getCatalogItem(c.req.param('itemId'));
					if (!item) {
						return jsonError(c, 404, `Unknown catalog item "${c.req.param('itemId')}".`);
					}
					const canAccess = await store.principalCanAccessCatalogItem(c.get('principal'), item);
					if (!canAccess) {
						return jsonError(c, 404, `Unknown catalog item "${c.req.param('itemId')}".`);
					}
					return c.json({ ok: true, payload: item });
				});
	
	app.get('/v1/catalog/:itemId/artifacts', async (c) => {
					const item = await store.getCatalogItem(c.req.param('itemId'));
					if (!item) {
						return jsonError(c, 404, `Unknown catalog item "${c.req.param('itemId')}".`);
					}
					const canAccess = await store.principalCanAccessCatalogItem(c.get('principal'), item);
					if (!canAccess) {
						return jsonError(c, 404, `Unknown catalog item "${c.req.param('itemId')}".`);
					}
					return c.json({
						ok: true,
						payload: await store.listCatalogArtifactVersions(item.id),
					});
				});
	
	app.get('/v1/catalog/:itemId/artifacts/:version/download', async (c) => {
					const item = await store.getCatalogItem(c.req.param('itemId'));
					if (!item) {
						return jsonError(c, 404, `Unknown catalog item "${c.req.param('itemId')}".`);
					}
					const canAccess = await store.principalCanAccessCatalogItem(c.get('principal'), item);
					if (!canAccess) {
						return jsonError(c, 404, `Unknown catalog item "${c.req.param('itemId')}".`);
					}
					const artifact = await store.getCatalogArtifactVersion(item.id, c.req.param('version'));
					if (!artifact) {
						return jsonError(c, 404, `Unknown catalog artifact version "${c.req.param('version')}".`);
					}
					return c.json({
						ok: true,
						payload: artifactDownloadPayload(runtime.resolved.config.baseUrl, item, artifact),
					});
				});
}
