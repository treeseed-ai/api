export function installGovernanceTeamProjectPolicyRoutes(context: any) {
	const { app, jsonThrownError, optionalTrimmedString, readJsonOrFormBody, requireProjectAccess, requireTeamAccess, store } = context;
	app.get('/v1/teams/:teamId/governance-policy', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.getTeamGovernancePolicy(c.req.param('teamId'), optionalTrimmedString(c.req.query('scope')) ?? 'team') });
				});
	
	app.post('/v1/teams/:teamId/governance-policy', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await readJsonOrFormBody(c);
					try {
						return c.json({ ok: true, payload: await store.setTeamGovernancePolicy(c.req.param('teamId'), {
							...body,
							createdBy: access.principal.id,
						}) });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});
	
	app.get('/v1/projects/:projectId/governance-policy', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.getProjectGovernancePolicy(access.details.project.id) });
				});
	
	app.post('/v1/projects/:projectId/governance-policy', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await readJsonOrFormBody(c);
					try {
						return c.json({ ok: true, payload: await store.setProjectGovernancePolicy(access.details.project.id, {
							...body,
							createdBy: access.principal.id,
						}) });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});
}
