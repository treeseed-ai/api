export function installTreedxTeamServiceAndPublicFederationRoutes(context: any) {
	const { app, config, enqueueTreeDxProvisionOperation, jsonError, optionalTrimmedString, requireConfiguredServiceCredential, requireTeamAccess, resolvePublicTreeDxTeam, runtime, store } = context;
	app.get('/v1/teams/:teamId/treedx', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.getTeamTreeDx(c.req.param('teamId')) });
				});
	
	app.put('/v1/teams/:teamId/treedx', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const instance = await store.upsertTeamTreeDx(c.req.param('teamId'), body);
					return c.json({ ok: true, payload: { instance } });
				});
	
	app.post('/v1/teams/:teamId/treedx/provision', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const payload = await store.provisionTeamTreeDx(c.req.param('teamId'), body);
					if (!payload) return jsonError(c, 404, 'Unknown team.');
					const { operation } = await enqueueTreeDxProvisionOperation(store, c.req.param('teamId'), payload, body, {
						type: 'user',
						id: access.principal.id,
					});
					return c.json({ ok: true, payload: { ...payload, operation } }, { status: 202 });
				});
	
	app.post('/v1/internal/treedx/public-federation/provision', async (c) => {
					const service = requireConfiguredServiceCredential(c, runtime.resolved.config);
					if (service.response) return service.response;
					const body = await c.req.json().catch(() => ({}));
					const team = await resolvePublicTreeDxTeam(store, body);
					const payload = await store.provisionTeamTreeDx(team.id, {
						...body,
						publicRead: true,
						imageRef: optionalTrimmedString(body.imageRef) ?? 'treeseed/treedx:latest',
						name: optionalTrimmedString(body.name) ?? 'TreeSeed public federation',
					});
					const { operation } = await enqueueTreeDxProvisionOperation(store, team.id, payload, body, {
						type: 'service',
						id: 'public-treedx-bootstrap',
					});
					return c.json({ ok: true, payload: { ...payload, team, operation } }, { status: 202 });
				});
}
