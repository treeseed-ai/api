export function installCatalogSeedRunLifecycleRoutes(context: any) {
	const { app, applySeedWithStore, config, ensurePrincipal, jsonError, normalizeSeedEnvironments, planSeedWithStore, requireSeedApplyAccess, requireSeedPlanAccess, seedActor, store } = context;
	app.get('/v1/seeds/runs', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const limit = Number(c.req.query('limit') ?? 50);
					return c.json({ ok: true, payload: await store.listSeedRuns(limit) });
				});
	
	app.get('/v1/seeds/runs/:runId', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const run = await store.getSeedRun(c.req.param('runId'));
					if (!run) return jsonError(c, 404, 'Unknown seed run.');
					return c.json({ ok: true, payload: run });
				});
	
	app.post('/v1/seeds/:name/plan', async (c) => {
					const body = await c.req.json().catch(() => ({}));
					const planned = await planSeedWithStore({
						projectRoot: config.repoRoot,
						seedName: c.req.param('name'),
						environments: normalizeSeedEnvironments(body.environments),
						manifestRef: typeof body.manifestRef === 'string' ? body.manifestRef : undefined,
						mode: 'plan',
						store,
						actor: seedActor(c),
					});
					if (!planned.plan) {
						return c.json({
							ok: false,
							seed: c.req.param('name'),
							mode: 'plan',
							environments: [],
							summary: null,
							actions: [],
							diagnostics: planned.diagnostics,
						}, { status: 400 });
					}
					const access = await requireSeedPlanAccess(c, store, planned.plan);
					if (access.response) return access.response;
					const run = await store.createSeedRun({
						seedName: planned.plan.seed,
						seedVersion: planned.plan.version,
						environments: planned.plan.environments,
						mode: 'plan',
						state: 'completed',
						actorType: seedActor(c).actorType,
						actorId: access.principal.id,
						manifestHash: planned['manifestHash'],
						plan: planned.plan,
						result: { actionCount: planned.plan.summary.create + planned.plan.summary.update },
						completedAt: new Date().toISOString(),
					});
					return c.json({
						ok: true,
						seed: planned.plan.seed,
						mode: 'plan',
						environments: planned.plan.environments,
						summary: planned.plan.summary,
						actions: planned.plan.actions,
						runtime: planned.plan.runtime,
						diagnostics: planned.plan.diagnostics,
						run,
					});
				});
	
	app.post('/v1/seeds/:name/apply', async (c) => {
					const body = await c.req.json().catch(() => ({}));
					const planned = await planSeedWithStore({
						projectRoot: config.repoRoot,
						seedName: c.req.param('name'),
						environments: normalizeSeedEnvironments(body.environments),
						manifestRef: typeof body.manifestRef === 'string' ? body.manifestRef : undefined,
						mode: 'apply',
						store,
						actor: seedActor(c),
					});
					if (!planned.plan) {
						return c.json({
							ok: false,
							seed: c.req.param('name'),
							mode: 'apply',
							environments: [],
							summary: null,
							actions: [],
							diagnostics: planned.diagnostics,
						}, { status: 400 });
					}
					const access = await requireSeedApplyAccess(c, store, planned.plan);
					if (access.response) return access.response;
					const applied = await applySeedWithStore({
						projectRoot: config.repoRoot,
						seedName: c.req.param('name'),
						environments: normalizeSeedEnvironments(body.environments),
						manifestRef: typeof body.manifestRef === 'string' ? body.manifestRef : undefined,
						approvalRequestId: typeof body.approvalRequestId === 'string' ? body.approvalRequestId : undefined,
						store,
						localOnly: planned.plan.environments.length === 1 && planned.plan.environments[0] === 'local',
						actor: {
							...seedActor(c),
							principal: access.principal,
						},
					});
					const blocked = applied.result?.blocked === true;
					return c.json({
						ok: !blocked,
						seed: applied.plan.seed,
						mode: 'apply',
						environments: applied.plan.environments,
						summary: applied.plan.summary,
						runtime: applied.plan.runtime,
						actions: applied.plan.actions,
						diagnostics: applied.plan.diagnostics,
						run: applied.run,
						result: applied.result,
						...(blocked ? { error: applied.result.reason } : {}),
					}, { status: blocked ? 409 : 200 });
				});
}
