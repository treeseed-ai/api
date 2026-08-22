import { commitProposalVersionContent } from './proposal-version-content.ts';

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
	if (!administrator(principal) && principal.roles?.includes('team_api_key') && permission
		&& !principal.permissions?.some((value) => value === permission || value === '*:*:*')) {
		throw new GovernanceServiceError(403, 'project_permission_denied', `The operation requires ${permission}.`);
	}
	return details.project;
}

function optionalText(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }

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
			try {
				return await store.createGovernanceProposal(principal, { ...body, teamId: project.teamId, projectId: project.id,
					scope: 'project', createdByType: actorType(principal), createdById: principal!.id });
			} catch (error) { fail(error, 'governance_proposal_create_failed'); }
		},
		async updateProposal(principal: Principal, projectId: string, proposalId: string, body: Record<string, unknown>, ifMatch?: string) {
			await projectFor(store, principal, projectId, 'projects:manage:team');
			const proposal = await proposalFor(store, projectId, proposalId);
			const update = versionedBody(body, ifMatch);
			let authored: Awaited<ReturnType<typeof commitProposalVersionContent>> | undefined;
			try {
				try {
					const replay = await store.updateGovernanceProposalDraft(principal, proposal.id,
						{ ...update, contentProvenance: proposal.metadata?.contentProvenance, repairExistingVersion: true });
					return { proposal: replay, idempotentReplay: true };
				} catch (error) {
					if ((error as { code?: string }).code !== 'governance_proposal_repair_material_change') throw error;
				}
				authored = await commitProposalVersionContent({ store, proposal, principal: principal!, update });
				const updated = await store.updateGovernanceProposalDraft(principal, proposal.id, authored.update);
				return { proposal: updated, authoringReceipt: authored.receipt, idempotentReplay: false };
			} catch (error) {
				if (authored?.receipt) throw new GovernanceServiceError(409, 'proposal_version_unbound',
					'Proposal governance changed after the TreeDX commit.');
				fail(error, 'governance_proposal_update_failed');
			}
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
