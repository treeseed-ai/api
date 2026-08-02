export function installFoundationStewardTransitionCommonsProposalRoutes(context: any) {
	const { jsonError, optionalTrimmedString, store } = context;
	async function stewardTransitionCommonsProposal(c, nextState) {
					const steward = await context.requireCommonsSteward(c);
					if (steward.response) return steward.response;
					const body = await c.req.json().catch(() => ({}));
					const proposal = await store.transitionCommonsProposal(c.req.param('proposalId'), nextState, {
						actorType: 'user',
						actorId: steward.principal.id ?? null,
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						votingEndsAt: optionalTrimmedString(body.votingEndsAt),
					});
					return proposal ? c.json({ ok: true, payload: proposal }) : jsonError(c, 404, 'Unknown Commons proposal.');
				}
	context.stewardTransitionCommonsProposal = stewardTransitionCommonsProposal;
}
