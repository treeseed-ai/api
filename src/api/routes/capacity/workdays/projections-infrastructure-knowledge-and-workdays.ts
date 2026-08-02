export function installProjectionsInfrastructureKnowledgeAndWorkdaysRoutes(context: any) {
	const { app, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildWorkdayProjection, capacity, config, decodeRouteParam, jsonError, loadInfrastructureSeedState, loadKnowledgeContentEntries, resolveUiProjectionContext, runtime, store, uiRuntimeLocals } = context;
	
	app.get('/v1/ui/knowledge', async (c) => {
					const context = await resolveUiProjectionContext(c, store);
					if (context.response) return context.response;
					const contentEntries = await loadKnowledgeContentEntries().catch(() => []);
					const projection = await buildKnowledgeProjection({
						store: capacity,
						principal: context.principal,
						teams: context.teams,
						projects: context.projects,
						contentEntries,
					});
					return c.json({ ok: true, payload: projection });
				});
	
	app.get('/v1/ui/knowledge/:artifactId', async (c) => {
					const context = await resolveUiProjectionContext(c, store);
					if (context.response) return context.response;
					const contentEntries = await loadKnowledgeContentEntries().catch(() => []);
					const artifact = await buildKnowledgeArtifactProjection({
						store: capacity,
						principal: context.principal,
						teams: context.teams,
						projects: context.projects,
						contentEntries,
						artifactId: decodeRouteParam(c.req.param('artifactId')),
					});
					if (!artifact) return jsonError(c, 404, 'Unknown knowledge artifact.');
					return c.json({ ok: true, payload: artifact });
				});
	
	app.get('/v1/ui/workdays/:workdayId', async (c) => {
					const context = await resolveUiProjectionContext(c, store);
					if (context.response) return context.response;
					const projection = await buildWorkdayProjection({
						store: capacity,
						principal: context.principal,
						projects: context.projects,
						workdayId: decodeRouteParam(c.req.param('workdayId')),
					});
					if (!projection) return jsonError(c, 404, 'Unknown workday.');
					return c.json({ ok: true, payload: projection });
				});
}
