type Principal = { id: string; roles?: string[]; permissions?: string[]; metadata?: Record<string, unknown> } | undefined;

export class GovernanceReaderError extends Error {
	constructor(readonly status: 401 | 403 | 404, readonly code: string, message: string) {
		super(message);
		this.name = 'GovernanceReaderError';
	}
}

function administrator(principal: Principal) {
	return principal?.roles?.some((role) => ['admin', 'platform_admin'].includes(role)) ?? false;
}

async function projectFor(store: any, principal: Principal, projectId: string) {
	if (!principal) throw new GovernanceReaderError(401, 'authentication_required', 'Authentication is required.');
	const details = await store.getProjectDetails(projectId);
	if (!details?.project) throw new GovernanceReaderError(404, 'project_not_found', 'Project not found.');
	if (!administrator(principal) && !await store.principalCanAccessTeam(principal, details.project.teamId)) {
		throw new GovernanceReaderError(403, 'project_access_denied', 'Project access is required.');
	}
	return details.project;
}

function optionalText(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }

async function proposalFor(store: any, projectId: string, proposalId: string) {
	const proposal = await store.getGovernanceProposal(proposalId);
	if (!proposal || proposal.projectId !== projectId) throw new GovernanceReaderError(404, 'governance_proposal_not_found', 'Unknown governance proposal.');
	return proposal;
}

async function decisionFor(store: any, projectId: string, decisionId: string) {
	const decision = await store.getGovernanceDecision(decisionId);
	if (!decision || decision.projectId !== projectId) throw new GovernanceReaderError(404, 'governance_decision_not_found', 'Unknown governance decision.');
	return decision;
}

export function createGovernanceReaderService(store: any) {
	return {
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
