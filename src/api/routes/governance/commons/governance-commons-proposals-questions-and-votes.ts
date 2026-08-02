export function installGovernanceCommonsProposalsQuestionsAndVotesRoutes(context: any) {
	const { app, ensurePrincipal, jsonError, optionalTrimmedString, parseJsonObject, principalIsSeedAdmin, store } = context;
	const { requireCommonsSteward, commonsErrorResponse } = context;
	app.get('/v1/commons/summary', async (c) => {
					return c.json({ ok: true, payload: await store.commonsSummary(c.get('principal') ?? null) });
				});
	
	app.get('/v1/commons/participants/me', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					try {
						return c.json({ ok: true, payload: await store.ensureCommonsParticipantForPrincipal(auth.principal) });
					} catch (error) {
						return commonsErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commons/participants', async (c) => {
					const steward = await requireCommonsSteward(c);
					if (steward.response) return steward.response;
					return c.json({ ok: true, payload: await store.listCommonsParticipants({
						status: optionalTrimmedString(c.req.query('status')),
						limit: c.req.query('limit'),
					}) });
				});
	
	app.post('/v1/commons/participants/backfill', async (c) => {
					const steward = await requireCommonsSteward(c);
					if (steward.response) return steward.response;
					const users = await store.all(`SELECT * FROM users ORDER BY created_at ASC`);
					const participants = [];
					for (const user of users) {
						participants.push(await store.ensureCommonsParticipantForPrincipal({
							id: user.id,
							displayName: user.display_name,
							email: user.email,
							roles: [],
							permissions: [],
							metadata: parseJsonObject(user.metadata_json, {}),
						}, { metadata: { registrationSource: 'backfill' } }));
					}
					return c.json({ ok: true, payload: { participants, count: participants.length } });
				});
	
	app.get('/v1/commons/questions', async (c) => {
					return c.json({ ok: true, payload: await store.listCommonsQuestions({
						status: optionalTrimmedString(c.req.query('status')),
						limit: c.req.query('limit'),
					}) });
				});
	
	app.post('/v1/commons/questions', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.createCommonsQuestion(auth.principal, {
							title: optionalTrimmedString(body.title),
							body: optionalTrimmedString(body.body),
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
						}) });
					} catch (error) {
						return commonsErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commons/questions/:questionId', async (c) => {
					const question = await store.getCommonsQuestion(c.req.param('questionId'));
					return question ? c.json({ ok: true, payload: question }) : jsonError(c, 404, 'Unknown Commons question.');
				});
	
	app.post('/v1/commons/questions/:questionId/answer', async (c) => {
					const steward = await requireCommonsSteward(c);
					if (steward.response) return steward.response;
					const body = await c.req.json().catch(() => ({}));
					const question = await store.answerCommonsQuestion(c.req.param('questionId'), {
						answer: optionalTrimmedString(body.answer ?? body.message),
						actorType: 'user',
						actorId: steward.principal.id ?? null,
					});
					return question ? c.json({ ok: true, payload: question }) : jsonError(c, 404, 'Unknown Commons question.');
				});
	
	app.post('/v1/commons/questions/:questionId/convert-to-proposal', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const question = await store.getCommonsQuestion(c.req.param('questionId'));
					if (!question) return jsonError(c, 404, 'Unknown Commons question.');
					if (question.userId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) return jsonError(c, 403, 'Permission denied.');
					const body = await c.req.json().catch(() => ({}));
					try {
						const proposal = await store.createCommonsProposal(auth.principal, {
							status: 'submitted',
							title: optionalTrimmedString(body.title) ?? question.title,
							summary: optionalTrimmedString(body.summary) ?? question.body.slice(0, 240),
							body: optionalTrimmedString(body.body) ?? question.body,
							scope: optionalTrimmedString(body.scope, 'treeseed_commons'),
							decisionType: optionalTrimmedString(body.decisionType, 'advisory'),
							metadata: { convertedFromQuestionId: question.id },
						});
						await store.run(`UPDATE commons_questions SET status = 'converted_to_proposal', converted_proposal_id = ?, updated_at = ? WHERE id = ?`, [proposal.id, new Date().toISOString(), question.id]);
						await store.recordCommonsGovernanceEvent({
							eventType: 'question.converted_to_proposal',
							actorType: 'user',
							actorId: auth.principal.id,
							participantId: proposal.participantId,
							questionId: question.id,
							proposalId: proposal.id,
							priorState: question.status,
							nextState: 'converted_to_proposal',
						});
						return c.json({ ok: true, payload: proposal });
					} catch (error) {
						return commonsErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commons/proposals', async (c) => {
					return c.json({ ok: true, payload: await store.listCommonsProposals({
						status: optionalTrimmedString(c.req.query('status')),
						scope: optionalTrimmedString(c.req.query('scope')),
						limit: c.req.query('limit'),
					}) });
				});
	
	app.post('/v1/commons/proposals', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.createCommonsProposal(auth.principal, {
							title: optionalTrimmedString(body.title),
							summary: optionalTrimmedString(body.summary),
							body: optionalTrimmedString(body.body),
							scope: optionalTrimmedString(body.scope, 'treeseed_commons'),
							decisionType: optionalTrimmedString(body.decisionType, 'advisory'),
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
						}) });
					} catch (error) {
						return commonsErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commons/proposals/:proposalId', async (c) => {
					const proposal = await store.getCommonsProposal(c.req.param('proposalId'));
					if (!proposal) return jsonError(c, 404, 'Unknown Commons proposal.');
					return c.json({ ok: true, payload: {
						...proposal,
						backings: await store.listCommonsProposalBackings(proposal.id),
						votes: await store.listCommonsProposalVotes(proposal.id),
						events: await store.listCommonsGovernanceEvents({ proposalId: proposal.id, limit: 50 }),
					} });
				});
	
	app.post('/v1/commons/proposals/:proposalId/submit', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const proposal = await store.getCommonsProposal(c.req.param('proposalId'));
					if (!proposal) return jsonError(c, 404, 'Unknown Commons proposal.');
					if (proposal.userId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) return jsonError(c, 403, 'Permission denied.');
					return c.json({ ok: true, payload: await store.submitCommonsProposal(proposal.id, { actorType: 'user', actorId: auth.principal.id }) });
				});
	
	app.post('/v1/commons/proposals/:proposalId/back', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						const proposal = await store.backCommonsProposal(auth.principal, c.req.param('proposalId'), { reason: optionalTrimmedString(body.reason) });
						return proposal ? c.json({ ok: true, payload: proposal }) : jsonError(c, 404, 'Unknown Commons proposal.');
					} catch (error) {
						return commonsErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commons/proposals/:proposalId/vote', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						const proposal = await store.voteCommonsProposal(auth.principal, c.req.param('proposalId'), {
							vote: optionalTrimmedString(body.vote),
							reason: optionalTrimmedString(body.reason),
						});
						return proposal ? c.json({ ok: true, payload: proposal }) : jsonError(c, 404, 'Unknown Commons proposal.');
					} catch (error) {
						return commonsErrorResponse(c, error);
					}
				});
}
