import type { GovernanceProposalReadiness } from '../../../../governance/proposal-readiness.ts';
import type { ControlPlaneStore } from '../../../../persistence/store.ts';
import { readExactProposal } from '../../../../governance/executable-proposal.ts';

type Row = Record<string, unknown>;
function record(value: unknown): Row { if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row; if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; } return {}; }
function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }

export async function governanceProposalReadinessMethod(this: ControlPlaneStore, proposalId: string): Promise<GovernanceProposalReadiness | null> {
	const proposal = await this.getGovernanceProposal(proposalId);
	if (!proposal) return null;
	const proposalVersion = Number(proposal.activeVersion ?? 0);
	const events = await this.all(`SELECT id, actor_id, event_type, evidence_json FROM governance_events WHERE proposal_id = ? ORDER BY created_at ASC LIMIT 500`, [proposalId]);
	const resolved = new Set(events.map((row) => text(record(row.evidence_json).resolvesEventId)).filter(Boolean));
	const discussions = events.map((row) => ({ ...row, evidence: record(row.evidence_json) })).filter((row) => row.event_type === 'proposal.discussion');
	const blockers = discussions.filter((row) => ['question', 'concern'].includes(text(row.evidence.kind))
		&& text(row.evidence.feedbackSeverity) !== 'advisory'
		&& !['resolved', 'withdrawn'].includes(text(row.evidence.feedbackStatus))
		&& !resolved.has(text(row.id)));
	const reviews = discussions.filter((row) => ['support', 'concern'].includes(text(row.evidence.kind)) && text(row.actor_id) !== text(proposal.createdById)
		&& Number(row.evidence.proposalVersion) === proposalVersion);
	let executionPlanReady = false;
	let exactSourceProblem: string | null = null;
	if (proposal.projectId) try {
		const exact = await readExactProposal(this, proposal as unknown as Row);
		executionPlanReady = exact.definition.status === 'ready' && Boolean(exact.definition.executionPlan);
	} catch (error) {
		exactSourceProblem = text(record(error).code) || (error instanceof Error ? error.message : 'proposal_exact_source_invalid');
	}
	const missingContent = exactSourceProblem ? [`exact proposal source (${exactSourceProblem})`] : [];
	const missingVoting = [...missingContent];
	if (!executionPlanReady) missingVoting.push('ready proposal-owned execution plan');
	if (reviews.length < 1) missingVoting.push('independent Reviewer disposition');
	if (blockers.length) missingVoting.push('resolved blocking questions and concerns');
	return {
		contentReady: missingContent.length === 0,
		votingReady: missingVoting.length === 0,
		missingContent, missingVoting,
		independentReviewCount: reviews.length,
		estimateCount: executionPlanReady ? 1 : 0,
		unresolvedBlockerCount: blockers.length,
		missingParticipantEstimates: [],
		missingReviewerClasses: [],
		participationVersionReady: true,
		authorIndependent: true,
		executionPlanReady,
	};
}

export async function assertGovernanceProposalReady(this: ControlPlaneStore, proposalId: string, stage: 'content' | 'voting') {
	const readiness = await governanceProposalReadinessMethod.call(this, proposalId);
	if (!readiness) return null;
	const missing = stage === 'content' ? readiness.missingContent : readiness.missingVoting;
	if (missing.length) {
		const error: Error & Record<string, unknown> = new Error(`Proposal is not ready for ${stage === 'content' ? 'discussion' : 'voting'}: ${missing.join(', ')}.`);
		error.status = 409; error.code = 'governance_proposal_not_ready'; error.readiness = readiness; throw error;
	}
	return readiness;
}
