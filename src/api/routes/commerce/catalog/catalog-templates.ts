export function installCatalogTemplateRoutes(context: any) {
	const { app, loadTemplateCatalog, runtime, store } = context;
	app.get('/v1/templates', async (c: any) => {
		const catalog = await store.listCatalogItems(c.get('principal'), { kind: 'template' });
		return c.json({ ok: true, payload: catalog.length > 0 ? { items: catalog } : loadTemplateCatalog(runtime.resolved.config) });
	});
}
