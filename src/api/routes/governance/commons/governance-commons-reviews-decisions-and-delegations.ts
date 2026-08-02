export function installGovernanceCommonsReviewsDecisionsAndDelegationsRoutes(context: any) {
	const { app, ensurePrincipal, jsonError, optionalTrimmedString, store } = context;
	const { requireCommonsSteward, commonsErrorResponse, stewardTransitionCommonsProposal } = context;
	app.post('/v1/commons/proposals/:proposalId/review', async (c) => stewardTransitionCommonsProposal(c, 'under_review'));
	
	app.post('/v1/commons/proposals/:proposalId/start-voting', async (c) => stewardTransitionCommonsProposal(c, 'voting'));
	
	app.post('/v1/commons/proposals/:proposalId/archive', async (c) => stewardTransitionCommonsProposal(c, 'archived'));
	
	app.post('/v1/commons/proposals/:proposalId/evaluate', async (c) => {
					const steward = await requireCommonsSteward(c);
					if (steward.response) return steward.response;
					const proposal = await store.getCommonsProposal(c.req.param('proposalId'));
					if (!proposal) return jsonError(c, 404, 'Unknown Commons proposal.');
					const target = proposal.backingCount >= 3 ? 'qualified' : proposal.status;
					return c.json({ ok: true, payload: target === proposal.status ? proposal : await store.transitionCommonsProposal(proposal.id, target, {
						actorType: 'user',
						actorId: steward.principal.id ?? null,
						reason: 'Steward evaluated proposal backing threshold.',
					}) });
				});
	
	app.post('/v1/commons/proposals/:proposalId/steward-decision', async (c) => {
					const steward = await requireCommonsSteward(c);
					if (steward.response) return steward.response;
					const body = await c.req.json().catch(() => ({}));
					const result = await store.stewardDecisionForCommonsProposal(c.req.param('proposalId'), {
						status: optionalTrimmedString(body.status),
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						capacityBudget: optionalTrimmedString(body.capacityBudget),
						scheduledFor: optionalTrimmedString(body.scheduledFor),
						actorType: 'user',
						actorId: steward.principal.id ?? null,
					});
					return result ? c.json({ ok: true, payload: result }) : jsonError(c, 404, 'Unknown Commons proposal.');
				});
	
	app.get('/v1/commons/proposals/:proposalId/events', async (c) => {
					const proposal = await store.getCommonsProposal(c.req.param('proposalId'));
					if (!proposal) return jsonError(c, 404, 'Unknown Commons proposal.');
					return c.json({ ok: true, payload: await store.listCommonsGovernanceEvents({ proposalId: proposal.id, limit: c.req.query('limit') }) });
				});
	
	app.get('/v1/commons/decisions', async (c) => {
					return c.json({ ok: true, payload: await store.listCommonsDecisions({ limit: c.req.query('limit') }) });
				});
	
	app.get('/v1/commons/events', async (c) => {
					return c.json({ ok: true, payload: await store.listCommonsGovernanceEvents({ limit: c.req.query('limit') }) });
				});
	
	app.get('/v1/commons/delegations', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					return c.json({ ok: true, payload: await store.listCommonsDelegations(auth.principal) });
				});
	
	app.post('/v1/commons/delegations', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.createCommonsDelegation(auth.principal, body) });
					} catch (error) {
						return commonsErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commons/delegations/:delegationId/revoke', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						const delegation = await store.revokeCommonsDelegation(auth.principal, c.req.param('delegationId'), { reason: optionalTrimmedString(body.reason) });
						return delegation ? c.json({ ok: true, payload: delegation }) : jsonError(c, 404, 'Unknown Commons delegation.');
					} catch (error) {
						return commonsErrorResponse(c, error);
					}
				});
}
