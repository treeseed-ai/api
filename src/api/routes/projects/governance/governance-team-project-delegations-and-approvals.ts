export function installGovernanceTeamProjectDelegationsAndApprovalsRoutes(context: any) {
	const { app, capacity, findById, jsonError, jsonThrownError, optionalTrimmedString, readJsonOrFormBody, requireProjectAccess, requireTeamAccess, store } = context;
	app.get('/v1/teams/:teamId/governance-delegations', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listGovernanceDelegations({
						teamId: c.req.param('teamId'),
						scope: optionalTrimmedString(c.req.query('scope')),
						status: optionalTrimmedString(c.req.query('status')),
						limit: c.req.query('limit'),
					}) });
				});
	
	app.post('/v1/teams/:teamId/governance-delegations', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					const body = await readJsonOrFormBody(c);
					try {
						return c.json({ ok: true, payload: await store.createGovernanceDelegation(access.principal, {
							...body,
							teamId: c.req.param('teamId'),
						}) }, { status: 201 });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});
	
	app.delete('/v1/teams/:teamId/governance-delegations/:delegationId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					const body = await readJsonOrFormBody(c);
					try {
						const delegation = await store.revokeGovernanceDelegation(access.principal, c.req.param('delegationId'), body);
						if (!delegation || delegation.teamId !== c.req.param('teamId')) return jsonError(c, 404, 'Unknown governance delegation.');
						return c.json({ ok: true, payload: delegation });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});
	
	app.get('/v1/projects/:projectId/governance-delegations', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listGovernanceDelegations({
						teamId: access.details.project.teamId,
						scope: optionalTrimmedString(c.req.query('scope')) ?? 'project',
						status: optionalTrimmedString(c.req.query('status')),
						limit: c.req.query('limit'),
					}) });
				});
	
	app.get('/v1/projects/:projectId/approvals', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: {
							projectId: access.details.project.id,
							items: await store.listApprovalRequestsForProject(access.details.project.id, 200),
						},
					});
				});
	
	app.get('/v1/projects/:projectId/approvals/:approvalId', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					const approvalId = c.req.param('approvalId');
					const summary = await capacity.getProjectAgentsSummary(access.details.project.id, access.principal);
					const approval = findById(summary?.approvals, approvalId);
					return approval
						? c.json({ ok: true, payload: { projectId: access.details.project.id, approval } })
						: jsonError(c, 404, 'Unknown approval request.');
				});
}
