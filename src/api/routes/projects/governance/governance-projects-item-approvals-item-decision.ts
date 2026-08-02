export function installGovernanceProjectsItemApprovalsItemDecisionRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, app, jsonError, readJsonOrFormBody, requireProjectAccess, store } = context;
	app.post('/v1/projects/:projectId/approvals/:approvalId/decision', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					if (c.get('actorType') === 'service') {
						return jsonError(c, 403, 'Service principals cannot decide agent approvals.');
					}
					const body = await readJsonOrFormBody(c);
					const decision = typeof body.decision === 'string' && body.decision.trim() ? body.decision.trim() : '';
					if (!decision) {
						return jsonError(c, 400, 'Approval decision is required.');
					}
					if (!AGENT_PROMOTION_APPROVAL_DECISIONS.has(decision)) {
						return jsonError(c, 400, 'Unsupported approval decision.');
					}
					const approvalId = c.req.param('approvalId');
					const approval = await store.getApprovalRequest(approvalId);
					if (!approval || approval.projectId !== access.details.project.id) {
						return jsonError(c, 404, 'Unknown approval request.');
					}
					const payload = await store.decideApprovalRequest(approvalId, {
						decision,
						reason: typeof body.reason === 'string' ? body.reason : null,
						decidedBy: access.principal.id,
					});
					return c.json({ ok: true, payload });
				});
}
