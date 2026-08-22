import { simulationEvidence } from '../../../store/governance/policy/support/simulation-evidence.ts';
import { createProposalDiscussionContent } from './proposal-discussion-content.ts';
import { commitProposalVersionContent } from './proposal-version-content.ts';

export function installProjectsProposalsAndDecisionsRoutes(context: any) {
	const { app, isTeamApiPrincipal, jsonError, jsonThrownError, optionalTrimmedString, readJsonOrFormBody, requireProjectAccess, store } = context;
	app.post('/v1/projects/:projectId/proposals', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await readJsonOrFormBody(c);
					try {
						return c.json({ ok: true, payload: await store.createGovernanceProposal(access.principal, {
							...body,
							teamId: access.details.project.teamId,
							projectId: access.details.project.id,
							scope: 'project',
							createdByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
							createdById: access.principal.id,
						}) }, { status: 201 });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});
	
	app.patch('/v1/projects/:projectId/proposals/:proposalId', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const proposal = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!proposal || proposal.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					const body = await readJsonOrFormBody(c);
					let authored;
					try {
						try {
							const replay = await store.updateGovernanceProposalDraft(access.principal, proposal.id, { ...body, contentProvenance: proposal.metadata?.contentProvenance, repairExistingVersion: true });
							return c.json({ ok: true, payload: replay, idempotentReplay: true });
						} catch (error) {
							if ((error as { code?: string }).code !== 'governance_proposal_repair_material_change') throw error;
						}
						authored = await commitProposalVersionContent({ store, proposal, principal: access.principal, update: body });
						return c.json({ ok: true, payload: await store.updateGovernanceProposalDraft(access.principal, proposal.id, authored.update), authoringReceipt: authored.receipt });
					} catch (error) {
						if (authored?.receipt) return c.json({ ok: false, code: 'proposal_version_unbound', error: error instanceof Error ? error.message : 'Proposal governance changed after the TreeDX commit.', authoringReceipt: authored.receipt, currentProposal: await store.getGovernanceProposal(proposal.id) }, 409);
						return jsonThrownError(c, error, 400);
					}
				});
	
	app.post('/v1/projects/:projectId/proposals/:proposalId/open', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await readJsonOrFormBody(c);
					try {
						const proposal = await store.openGovernanceProposal(access.principal, c.req.param('proposalId'), body);
						if (!proposal || proposal.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
						return c.json({ ok: true, payload: proposal });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});
	
	app.post('/v1/projects/:projectId/proposals/:proposalId/start-voting', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await readJsonOrFormBody(c);
					try {
						const proposal = await store.startGovernanceProposalVoting(access.principal, c.req.param('proposalId'), body);
						if (!proposal || proposal.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
						return c.json({ ok: true, payload: proposal });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});

	app.post('/v1/projects/:projectId/proposals/:proposalId/discussion', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					const proposal = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!proposal || proposal.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					if (!['draft', 'open', 'voting'].includes(proposal.status)) return jsonError(c, 409, 'Proposal discussion is closed.');
					const body = await readJsonOrFormBody(c);
					const expectedVersion = Number(body.expectedProposalVersion);
					if (Number.isFinite(expectedVersion) && expectedVersion > 0 && expectedVersion !== proposal.activeVersion) return jsonError(c, 409, 'Proposal changed after it was inspected.');
					const kind = optionalTrimmedString(body.kind);
					const message = optionalTrimmedString(body.message);
					const resolvesEventId = optionalTrimmedString(body.resolvesEventId);
					if (!kind || !['question', 'concern', 'support', 'response'].includes(kind)) {
						return jsonError(c, 400, 'Discussion kind must be question, concern, support, or response.');
					}
					if (!message) return jsonError(c, 400, 'Discussion message is required.');
					if (resolvesEventId) {
						if (kind !== 'response') return jsonError(c, 400, 'Only a response may resolve a proposal question or concern.');
						const resolved = await store.first(`SELECT id, evidence_json FROM governance_events WHERE id = ? AND proposal_id = ? AND event_type = 'proposal.discussion' LIMIT 1`, [resolvesEventId, proposal.id]);
						let evidence = {};
						try { evidence = JSON.parse(String(resolved?.evidence_json ?? '{}')); } catch { return jsonError(c, 409, 'The discussion being resolved has invalid evidence.'); }
						if (!resolved || !['question', 'concern'].includes(String(evidence.kind ?? ''))) return jsonError(c, 409, 'The referenced discussion is not a blocking question or concern.');
					}
					let contentReference;
					try {
						contentReference = await createProposalDiscussionContent({ store, proposal, principal: access.principal, kind, message, idempotencyKey: c.req.header('Idempotency-Key') || crypto.randomUUID(), contributorRef: optionalTrimmedString(body.contentContributorRef) });
					} catch (error) {
						return jsonThrownError(c, error, 503);
					}
					return c.json({ ok: true, payload: await store.recordGovernanceEvent({
						eventType: 'proposal.discussion',
						actorType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						actorId: access.principal.id,
						teamId: proposal.teamId,
						projectId: proposal.projectId,
						proposalId: proposal.id,
						proposalVersion: proposal.activeVersion,
						message,
						evidence: { kind, contentReference, ...(resolvesEventId ? { resolvesEventId } : {}), automatedEvolutionTest: body.automatedEvolutionTest === true, ...simulationEvidence(body, access.principal.id) },
					}) }, { status: 201 });
				});
	
	app.post('/v1/projects/:projectId/proposals/:proposalId/vote', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					const body = await readJsonOrFormBody(c);
					try {
						return c.json({ ok: true, payload: await store.voteGovernanceProposal(access.principal, existing.id, body) });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});
	
	app.post('/v1/projects/:projectId/proposals/:proposalId/evaluate', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					const body = await readJsonOrFormBody(c);
					return c.json({ ok: true, payload: await store.evaluateGovernanceProposal(existing.id, {
						...body,
						actorType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						actorId: access.principal.id,
					}) });
				});
	
	app.post('/v1/projects/:projectId/proposals/:proposalId/admin-decision', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'teams:manage:team');
					if (access.response) return access.response;
					const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					const body = await readJsonOrFormBody(c);
					try {
						return c.json({ ok: true, payload: await store.adminDecideGovernanceProposal(access.principal, existing.id, body) });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});
	
	app.post('/v1/projects/:projectId/proposals/:proposalId/withdraw', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					const body = await readJsonOrFormBody(c);
					return c.json({ ok: true, payload: await store.withdrawGovernanceProposal(access.principal, existing.id, body) });
				});
	
	app.post('/v1/projects/:projectId/proposals/:proposalId/supersede', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					const body = await readJsonOrFormBody(c);
					return c.json({ ok: true, payload: await store.supersedeGovernanceProposal(access.principal, existing.id, body) });
				});
	
}
