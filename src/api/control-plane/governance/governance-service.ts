import { commitProposalVersionContent } from './proposal-version-content.ts';
import { governanceContentHash } from '../../persistence/store.ts';
import { reconcileExecutionGraph } from '../repositories/capacity/execution/execution-graph-service.ts';

type Principal = { id: string; roles?: string[]; permissions?: string[]; metadata?: Record<string, unknown> } | undefined;

export class GovernanceServiceError extends Error {
	constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 412 | 422 | 503, readonly code: string, message: string) {
		super(message);
		this.name = 'GovernanceServiceError';
	}
}

function administrator(principal: Principal) {
	return principal?.roles?.some((role) => ['admin', 'platform_admin'].includes(role)) ?? false;
}

async function projectFor(store: any, principal: Principal, projectId: string, permission?: string) {
	if (!principal) throw new GovernanceServiceError(401, 'authentication_required', 'Authentication is required.');
	const details = await store.getProjectDetails(projectId);
	if (!details?.project) throw new GovernanceServiceError(404, 'project_not_found', 'Project not found.');
	if (!administrator(principal) && !await store.principalCanAccessTeam(principal, details.project.teamId)) {
		throw new GovernanceServiceError(403, 'project_access_denied', 'Project access is required.');
	}
	if (!administrator(principal) && permission) {
		const access = await store.getTeamAccessSummary(details.project.teamId, principal);
		if (!access.permissions?.some((value: string) => value === permission || value === '*:*:*')) {
			throw new GovernanceServiceError(403, 'project_permission_denied', `The operation requires ${permission}.`);
		}
	}
	return details.project;
}

function optionalText(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

async function bindInitialProposalContent(store: any, proposal: any, authored: Awaited<ReturnType<typeof commitProposalVersionContent>>) {
	const update = authored.update;
	const metadata = { ...record(proposal.metadata), ...record(update.metadata), contentProvenance: update.contentProvenance };
	const title = optionalText(update.title) ?? String(proposal.title ?? '');
	const summary = optionalText(update.summary) ?? String(proposal.summary ?? '');
	const body = optionalText(update.body) ?? String(proposal.body ?? '');
	const proposalTypes = Array.isArray(update.proposalTypes) ? update.proposalTypes.map(String) : proposal.proposalTypes ?? [proposal.proposalType];
	const proposalType = proposalTypes[0] ?? proposal.proposalType ?? 'implementation';
	const contentHash = optionalText(record(update.contentProvenance).digest)
		?? governanceContentHash({ title, summary, body, proposalType, ...metadata });
	await store.batch([
		{ query: `UPDATE governance_proposals SET title=?,summary=?,body=?,proposal_type=?,proposal_types_json=?,metadata_json=?,active_content_hash=?,updated_at=? WHERE id=? AND active_version=1 AND active_content_hash=?`,
			params: [title, summary, body, proposalType, JSON.stringify(proposalTypes), JSON.stringify(metadata), contentHash, new Date().toISOString(), proposal.id, proposal.activeContentHash] },
		{ query: `UPDATE governance_proposal_versions SET title=?,summary=?,body=?,content_hash=? WHERE proposal_id=? AND version=1 AND content_hash=?`,
			params: [title, summary, body, contentHash, proposal.id, proposal.activeContentHash] },
	]);
	const bound = await store.getGovernanceProposal(proposal.id);
	const provenance = record(record(bound?.metadata).contentProvenance);
	if (!bound || provenance.commitSha !== authored.receipt.commitSha) throw new GovernanceServiceError(409, 'proposal_initial_content_unbound', 'The initial TreeDX proposal commit could not be bound to its governance record.');
	return bound;
}

async function proposalFor(store: any, projectId: string, proposalId: string) {
	const proposal = await store.getGovernanceProposal(proposalId);
	if (!proposal || proposal.projectId !== projectId) throw new GovernanceServiceError(404, 'governance_proposal_not_found', 'Unknown governance proposal.');
	return proposal;
}

async function decisionFor(store: any, projectId: string, decisionId: string) {
	const decision = await store.getGovernanceDecision(decisionId);
	if (!decision || decision.projectId !== projectId) throw new GovernanceServiceError(404, 'governance_decision_not_found', 'Unknown governance decision.');
	return decision;
}

function actorType(principal: Principal) {
	if (principal?.roles?.includes('team_api_key')) return 'team_api_key';
	if (principal?.roles?.includes('service')) return 'service';
	return 'user';
}

function versionedBody(body: Record<string, unknown>, ifMatch?: string) {
	const bodyVersion = Number(body.expectedProposalVersion);
	if (!ifMatch) return body;
	const headerVersion = Number(ifMatch.replace(/^.*:/u, ''));
	if (!Number.isInteger(headerVersion) || headerVersion < 1) {
		throw new GovernanceServiceError(412, 'proposal_precondition_invalid', 'If-Match must identify an exact proposal version.');
	}
	if (Number.isInteger(bodyVersion) && bodyVersion !== headerVersion) {
		throw new GovernanceServiceError(412, 'proposal_precondition_mismatch', 'If-Match and expectedProposalVersion disagree.');
	}
	return { ...body, expectedProposalVersion: headerVersion };
}

function fail(error: unknown, fallbackCode: string): never {
	if (error instanceof GovernanceServiceError) throw error;
	const value = error && typeof error === 'object' ? error as { status?: number; code?: string } : {};
	const status = [400, 401, 403, 404, 409, 412, 422, 503].includes(Number(value.status)) ? Number(value.status) : 400;
	throw new GovernanceServiceError(status as GovernanceServiceError['status'], value.code ?? fallbackCode,
		error instanceof Error ? error.message : 'Governance operation failed.');
}

const approvalDecisions = new Set(['approve', 'approve_as_book_content', 'request_changes', 'request_more_research',
	'defer', 'reject', 'approve_release', 'reject_release']);

function approvalState(decision: string) {
	if (['approve', 'approve_as_book_content', 'approve_release'].includes(decision)) return 'approved';
	if (decision === 'defer') return 'expired';
	return 'rejected';
}

export function createGovernanceService(store: any) {
	return {
		async approvals(principal: Principal, projectId: string, query: Record<string, unknown>) {
			const project = await projectFor(store, principal, projectId, 'projects:read:team');
			return { projectId: project.id, items: await store.listApprovalRequestsForProject(project.id, query.limit), cursor: null };
		},
		async approval(principal: Principal, projectId: string, approvalId: string) {
			const project = await projectFor(store, principal, projectId, 'projects:read:team');
			const approval = await store.getApprovalRequest(approvalId);
			if (!approval || approval.projectId !== project.id) throw new GovernanceServiceError(404, 'approval_not_found', 'Unknown approval request.');
			return { projectId: project.id, approval };
		},
		async decideApproval(principal: Principal, projectId: string, approvalId: string, body: Record<string, unknown>, ifMatch?: string) {
			await projectFor(store, principal, projectId, 'projects:manage:team');
			if (principal?.metadata?.serviceId || principal?.roles?.includes('service')) {
				throw new GovernanceServiceError(403, 'service_approval_decision_forbidden', 'Service principals cannot decide agent approvals.');
			}
			const approval = await store.getApprovalRequest(approvalId);
			if (!approval || approval.projectId !== projectId) throw new GovernanceServiceError(404, 'approval_not_found', 'Unknown approval request.');
			if (!ifMatch || ifMatch !== String(approval.updatedAt ?? '')) {
				throw new GovernanceServiceError(412, 'approval_precondition_failed', 'The approval changed after it was inspected.');
			}
			const decision = optionalText(body.decision) ?? '';
			if (!approvalDecisions.has(decision)) throw new GovernanceServiceError(400, 'approval_decision_invalid', 'Unsupported approval decision.');
			try {
				return await store.decideApprovalRequest(approvalId, { state: approvalState(decision), decidedByType: actorType(principal),
					decidedById: principal!.id, decision: { decision, reason: optionalText(body.reason) ?? null } });
			} catch (error) { fail(error, 'approval_decision_failed'); }
		},
		async createProposal(principal: Principal, projectId: string, body: Record<string, unknown>) {
			const project = await projectFor(store, principal, projectId, 'projects:manage:team');
			let created: any;
			let authored: Awaited<ReturnType<typeof commitProposalVersionContent>> | undefined;
			try {
				created = await store.createGovernanceProposal(principal, { ...body, teamId: project.teamId, projectId: project.id,
					scope: 'project', createdByType: actorType(principal), createdById: principal!.id });
				if (!created) throw new GovernanceServiceError(409, 'governance_proposal_create_failed', 'The proposal record was not created.');
				authored = await commitProposalVersionContent({ store, proposal: created, principal: principal!, initial: true,
					update: { ...body, title: created.title, summary: created.summary, body: created.body, proposalTypes: created.proposalTypes,
						changeReason: 'Create initial proposal request.' } });
				const proposal = await bindInitialProposalContent(store, created, authored);
				await reconcileExecutionGraph(store, project.teamId, { projectId: project.id },
					`proposal-create:${proposal.id}:${authored.receipt.commitSha}`);
				return { ...proposal, authoringReceipt: authored.receipt };
			} catch (error) {
				// A failed pre-commit TreeDX write must not strand an unauthoritative
				// PostgreSQL proposal. Once TreeDX committed bytes, preserve the row so
				// an explicit bind repair can recover the immutable content instead.
				if (created?.id && !authored?.receipt) await store.batch([
					{ query: 'DELETE FROM governance_events WHERE proposal_id = ?', params: [created.id] },
					{ query: 'DELETE FROM governance_proposal_versions WHERE proposal_id = ?', params: [created.id] },
					{ query: 'DELETE FROM governance_proposals WHERE id = ? AND active_version = 1', params: [created.id] },
				]);
				if (authored?.receipt) throw new GovernanceServiceError(409, 'proposal_initial_version_unbound',
					'Initial proposal content was committed to TreeDX but could not be bound to governance.');
				fail(error, 'governance_proposal_create_failed');
			}
		},
		async updateProposal(principal: Principal, projectId: string, proposalId: string, body: Record<string, unknown>, ifMatch?: string) {
			await projectFor(store, principal, projectId, 'projects:manage:team');
			const proposal = await proposalFor(store, projectId, proposalId);
			const update = versionedBody(body, ifMatch);
			let authored: Awaited<ReturnType<typeof commitProposalVersionContent>> | undefined;
			try {
				authored = await commitProposalVersionContent({ store, proposal, principal: principal!, update });
				const updated = await store.updateGovernanceProposalDraft(principal, proposal.id, authored.update);
				await reconcileExecutionGraph(store, proposal.teamId, { projectId },
					`proposal-update:${proposal.id}:${authored.receipt.commitSha}`);
				return { proposal: updated, authoringReceipt: authored.receipt, idempotentReplay: false };
			} catch (error) {
				if (authored?.receipt) throw new GovernanceServiceError(409, 'proposal_version_unbound',
					'Proposal governance changed after the TreeDX commit.');
				fail(error, 'governance_proposal_update_failed');
			}
		},
		async resolveProposalFeedback(principal: Principal, projectId: string, proposalId: string, feedbackId: string, body: Record<string, unknown>, ifMatch?: string) {
			await projectFor(store, principal, projectId, 'projects:manage:team');
			const proposal = await proposalFor(store, projectId, proposalId);
			const exact = versionedBody(body, ifMatch);
			if (Number(exact.expectedProposalVersion) !== Number(proposal.activeVersion)) {
				throw new GovernanceServiceError(412, 'proposal_precondition_failed', 'The proposal changed after its feedback was inspected.');
			}
			const message = optionalText(body.message);
			if (!message) throw new GovernanceServiceError(422, 'proposal_feedback_resolution_required', 'A resolution explanation is required.');
			const events = await store.listGovernanceEvents({ proposalId, limit: 300 });
			const feedback = events.find((event: any) => event.id === feedbackId && event.eventType === 'proposal.discussion');
			if (!feedback || !['question', 'concern'].includes(optionalText(feedback.evidence?.kind) ?? '')) {
				throw new GovernanceServiceError(404, 'proposal_feedback_not_found', 'Unknown blocking proposal feedback.');
			}
			const existing = events.find((event: any) => event.evidence?.resolvesEventId === feedbackId);
			if (existing) return { proposalId, feedbackId, resolution: existing, readiness: await store.governanceProposalReadiness(proposalId), idempotentReplay: true };
			const provenance = proposal.metadata?.contentProvenance ?? {};
			const contentPath = optionalText(provenance.contentPath) ?? optionalText(provenance.path);
			const commitSha = optionalText(provenance.commitSha);
			const digest = optionalText(provenance.digest) ?? optionalText(proposal.activeContentHash);
			if (!contentPath || !commitSha || !digest) {
				throw new GovernanceServiceError(409, 'proposal_feedback_resolution_provenance_missing', 'The current proposal revision lacks immutable TreeDX provenance.');
			}
			try {
				const resolution = await store.recordGovernanceEvent({
					id: `proposal-feedback-resolution:${feedbackId}:${proposal.activeVersion}`,
					eventType: 'proposal.discussion', actorType: actorType(principal), actorId: principal!.id,
					teamId: proposal.teamId, projectId, proposalId, proposalVersion: proposal.activeVersion, message,
					evidence: { kind: 'response', feedbackSeverity: 'advisory', feedbackStatus: 'resolved', resolvesEventId: feedbackId,
						contentPath, commitSha, digest, proposalVersion: proposal.activeVersion },
				});
				await reconcileExecutionGraph(store, proposal.teamId, { projectId },
					`proposal-feedback-resolution:${proposal.id}:${feedbackId}:${proposal.activeVersion}`);
				return { proposalId, feedbackId, resolution, readiness: await store.governanceProposalReadiness(proposalId), idempotentReplay: false };
			} catch (error) { fail(error, 'governance_proposal_feedback_resolution_failed'); }
		},
		async openProposal(principal: Principal, projectId: string, proposalId: string, body: Record<string, unknown>, ifMatch?: string) {
			await projectFor(store, principal, projectId, 'projects:manage:team');
			await proposalFor(store, projectId, proposalId);
			try { return await store.openGovernanceProposal(principal, proposalId, versionedBody(body, ifMatch)); }
			catch (error) { fail(error, 'governance_proposal_open_failed'); }
		},
		async startVoting(principal: Principal, projectId: string, proposalId: string, body: Record<string, unknown>, ifMatch?: string) {
			await projectFor(store, principal, projectId, 'projects:manage:team');
			await proposalFor(store, projectId, proposalId);
			try { return await store.startGovernanceProposalVoting(principal, proposalId, versionedBody(body, ifMatch)); }
			catch (error) { fail(error, 'governance_proposal_voting_failed'); }
		},
		async vote(principal: Principal, projectId: string, proposalId: string, body: Record<string, unknown>) {
			await projectFor(store, principal, projectId, 'projects:read:team');
			await proposalFor(store, projectId, proposalId);
			try { return await store.voteGovernanceProposal(principal, proposalId, body); }
			catch (error) { fail(error, 'governance_proposal_vote_failed'); }
		},
		async evaluate(principal: Principal, projectId: string, proposalId: string, body: Record<string, unknown>, ifMatch?: string) {
			await projectFor(store, principal, projectId, 'projects:manage:team');
			await proposalFor(store, projectId, proposalId);
			try { return await store.evaluateGovernanceProposal(proposalId, { ...versionedBody(body, ifMatch),
				actorType: actorType(principal), actorId: principal!.id }); }
			catch (error) { fail(error, 'governance_proposal_evaluate_failed'); }
		},
		async withdraw(principal: Principal, projectId: string, proposalId: string, body: Record<string, unknown>, ifMatch?: string) {
			await projectFor(store, principal, projectId, 'projects:manage:team');
			await proposalFor(store, projectId, proposalId);
			try { return await store.withdrawGovernanceProposal(principal, proposalId, versionedBody(body, ifMatch)); }
			catch (error) { fail(error, 'governance_proposal_withdraw_failed'); }
		},
		async supersede(principal: Principal, projectId: string, proposalId: string, body: Record<string, unknown>, ifMatch?: string) {
			await projectFor(store, principal, projectId, 'projects:manage:team');
			await proposalFor(store, projectId, proposalId);
			try { return await store.supersedeGovernanceProposal(principal, proposalId, versionedBody(body, ifMatch)); }
			catch (error) { fail(error, 'governance_proposal_supersede_failed'); }
		},
		async proposals(principal: Principal, projectId: string, query: Record<string, unknown>) {
			const project = await projectFor(store, principal, projectId);
			return { items: await store.listGovernanceProposals({ projectId: project.id,
				status: optionalText(query.status), limit: query.limit }), cursor: null };
		},
		async proposal(principal: Principal, projectId: string, proposalId: string) {
			await projectFor(store, principal, projectId);
			const proposal = await proposalFor(store, projectId, proposalId);
			return { ...proposal, votes: await store.listGovernanceProposalVotes(proposal.id),
				events: await store.listGovernanceEvents({ proposalId: proposal.id, limit: 100 }),
				readiness: await store.governanceProposalReadiness(proposal.id),
				decision: proposal.decisionId ? await store.getGovernanceDecision(proposal.decisionId) : null };
		},
		async proposalEvents(principal: Principal, projectId: string, proposalId: string, query: Record<string, unknown>) {
			await projectFor(store, principal, projectId);
			await proposalFor(store, projectId, proposalId);
			return { items: await store.listGovernanceEvents({ proposalId, limit: query.limit }), cursor: null };
		},
		async decisions(principal: Principal, projectId: string, query: Record<string, unknown>) {
			const project = await projectFor(store, principal, projectId);
			return { items: await store.listGovernanceDecisions({ projectId: project.id,
				status: optionalText(query.status), limit: query.limit }), cursor: null };
		},
		async decision(principal: Principal, projectId: string, decisionId: string) {
			await projectFor(store, principal, projectId);
			return decisionFor(store, projectId, decisionId);
		},
		async decisionEvents(principal: Principal, projectId: string, decisionId: string, query: Record<string, unknown>) {
			await projectFor(store, principal, projectId);
			await decisionFor(store, projectId, decisionId);
			return { items: await store.listGovernanceEvents({ decisionId, limit: query.limit }), cursor: null };
		},
	};
}
