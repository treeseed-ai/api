export function installGovernanceProjectionRoutes(context: any) {
	const { app, buildGovernanceApprovalProjection, buildGovernanceProjection, capacity, decodeRouteParam, jsonError, readJsonOrFormBody, resolveUiProjectionContext, store } = context;
	app.get('/v1/ui/governance', async (c) => {
					const context = await resolveUiProjectionContext(c, store);
					if (context.response) return context.response;
					const projection = await buildGovernanceProjection({
						store: capacity,
						principal: context.principal,
						teams: context.teams,
						projects: context.projects,
					});
					return c.json({ ok: true, payload: projection });
				});
	
	app.get('/v1/ui/governance/:approvalId', async (c) => {
					const context = await resolveUiProjectionContext(c, store);
					if (context.response) return context.response;
					const detail = await buildGovernanceApprovalProjection({
						store: capacity,
						principal: context.principal,
						teams: context.teams,
						projects: context.projects,
						approvalId: decodeRouteParam(c.req.param('approvalId')),
					});
					if (!detail) return jsonError(c, 404, 'Unknown approval request.');
					return c.json({ ok: true, payload: detail });
				});
	
	app.post('/v1/ui/governance/:approvalId/decision', async (c) => {
					const context = await resolveUiProjectionContext(c, store);
					if (context.response) return context.response;
					const approvalId = decodeRouteParam(c.req.param('approvalId'));
					const detail = await buildGovernanceApprovalProjection({
						store,
						principal: context.principal,
						teams: context.teams,
						projects: context.projects,
						approvalId,
					});
					if (!detail) return jsonError(c, 404, 'Unknown approval request.');
					if (!['pending', 'waiting_for_approval', 'under_review', 'approval_required'].includes(String(detail.approval.state ?? '').toLowerCase())) {
						return jsonError(c, 409, 'This approval request is not pending.', { state: detail.approval.state });
					}
					const body = await readJsonOrFormBody(c);
					const optionId = typeof body.optionId === 'string' ? body.optionId : typeof body.decision === 'string' ? body.decision : '';
					const option = detail.decisionOptions.find((entry) => entry.id === optionId) ?? detail.decisionOptions[0];
					const state = body.state === 'rejected' || option?.state === 'rejected' ? 'rejected' : 'approved';
					const decided = await store.decideApprovalRequest(detail.approval.approvalId, {
						state,
						decidedByType: 'user',
						decidedById: context.principal.id,
						decision: {
							optionId: option?.id ?? (optionId || null),
							note: typeof body.note === 'string' ? body.note : null,
						},
					});
					if (context.activeTeam && typeof store.deleteTeamInboxItemsByItemKey === 'function') {
						await store.deleteTeamInboxItemsByItemKey(context.activeTeam.id, detail.approval.approvalId).catch(() => {});
					}
					return c.json({ ok: true, payload: decided });
				});
}
