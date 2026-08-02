export function installTeamsTeamsItemCatalogItemsRoutes(context: any) {
	const { app, jsonError, requireTeamAccess, store } = context;
	app.post('/v1/teams/:teamId/catalog-items', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.kind || !body.slug || !body.title) {
						return jsonError(c, 400, 'kind, slug, and title are required.');
					}
					return c.json({
						ok: true,
						payload: await store.upsertCatalogItem(c.req.param('teamId'), {
							id: typeof body.id === 'string' ? body.id : undefined,
							kind: String(body.kind),
							slug: String(body.slug),
							title: String(body.title),
							summary: typeof body.summary === 'string' ? body.summary : null,
							visibility: typeof body.visibility === 'string' ? body.visibility : 'private',
							listingEnabled: body.listingEnabled === true,
							offerMode: typeof body.offerMode === 'string' ? body.offerMode : 'private',
							manifestKey: typeof body.manifestKey === 'string' ? body.manifestKey : null,
							artifactKey: typeof body.artifactKey === 'string' ? body.artifactKey : null,
							searchText: typeof body.searchText === 'string' ? body.searchText : null,
							metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
						}),
					});
				});
}
