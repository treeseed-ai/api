export function installFoundationApprovalDecisionsRoutes(context: any) {
	const { app, ensurePrincipal, jsonError, principalIsSeedAdmin, requireProjectAccess, requireTeamAccess, store } = context;
	app.post('/v1/approval-requests/:approvalRequestId/decide', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const request = await store.getApprovalRequest(c.req.param('approvalRequestId'));
					if (!request) {
						return jsonError(c, 404, 'Unknown approval request.');
					}
					const access = await requireProjectAccess(c, store, request.projectId, 'projects:manage:team');
					if (access.response) return access.response;
					if (request.state !== 'pending') {
						return jsonError(c, 409, 'This approval request is not pending.', { state: request.state });
					}
					const body = await c.req.json().catch(() => ({}));
					const decided = await store.decideApprovalRequest(request.id, {
						state: body.state === 'rejected' ? 'rejected' : 'approved',
						decidedByType: c.get('actorType') === 'service' ? 'service' : 'user',
						decidedById: access.principal.id,
						decision: typeof body.decision === 'object' && body.decision ? body.decision : {
							optionId: typeof body.optionId === 'string' ? body.optionId : null,
							note: typeof body.note === 'string' ? body.note : null,
						},
					});
					await store.deleteTeamInboxItemsByItemKey(request.teamId, request.id);
					return c.json({ ok: true, payload: decided });
				});
	
	async function requireCommonsSteward(c) {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth;
					if (principalIsSeedAdmin(auth.principal)) return auth;
					const team = await store.ensureCommonsTeam();
					const access = await requireTeamAccess(c, store, team.id, 'teams:manage:team');
					return access.response ? access : auth;
				}
	
	function commonsErrorResponse(c, error) {
					const status = Number(error?.status ?? 400);
					return jsonError(c, Number.isInteger(status) && status >= 400 ? status : 400, error instanceof Error ? error.message : String(error));
				}
	context.requireCommonsSteward = requireCommonsSteward;
	context.commonsErrorResponse = commonsErrorResponse;
}
