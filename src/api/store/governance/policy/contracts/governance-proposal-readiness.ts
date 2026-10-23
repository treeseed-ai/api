import type { GovernanceProposalReadiness } from '../../../../governance/proposal-readiness.ts';
import type { ControlPlaneStore } from '../../../../persistence/store.ts';
import { estimateSchema, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { hasCompleteExecutablePlan, readExactProposal } from '../../../../governance/executable-proposal.ts';
import { loadProposalBlockingFeedback } from '../../../../capacity/services/capacity/execution/proposal-planning-source.ts';

import { loadProposalGroupContributions } from '../../../../capacity/services/capacity/execution/proposal-contributions.ts';
import { projectTeamExecutionGraph } from '../../../../capacity/policy/execution/execution-graph-projector.ts';

type Row = Record<string, unknown>;
function record(value: unknown): Row { if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row; if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; } return {}; }
function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }


export async function governanceProposalReadinessMethod(this: ControlPlaneStore, proposalId: string): Promise<GovernanceProposalReadiness | null> {
	const proposal = await this.getGovernanceProposal(proposalId);
	if (!proposal) return null;
	const proposalVersion = Number(proposal.activeVersion ?? 0);
	const events = await this.all(`SELECT id, actor_id, event_type, evidence_json FROM governance_events WHERE proposal_id = ? ORDER BY created_at ASC LIMIT 500`, [proposalId]);
	const discussions = events.map((row): Row & { evidence: Row } => ({ ...row, evidence: record(row.evidence_json) })).filter((row) => row.event_type === 'proposal.discussion');
	const blockers = (await loadProposalBlockingFeedback(this, proposalId)).filter((feedback) => !feedback.resolved);
	const reviews = discussions.filter((row) => ['support', 'concern'].includes(text(row.evidence.kind)) && text(row.actor_id) !== text(proposal.createdById)
		&& Number(row.evidence.proposalVersion) === proposalVersion);
	let executionPlanReady = false;
	let exactSourceProblem: string | null = null;
	let estimateCount = 0;
	let missingParticipantEstimates: string[] = [];
	let missingReviewerClasses: string[] = [];
	let definition: Row | null = null;
	let exactRef: ExactEntityReference | null = null;
	if (proposal.projectId) try {
		const exact = await readExactProposal(this, proposal as unknown as Row);
		definition = exact.definition;
		exactRef = exact.ref;
		const plan = record(exact.definition.executionPlan);
		const workItems = Array.isArray(plan.workItems) ? plan.workItems.map(record) : [];
		estimateCount = workItems.filter((item) => estimateSchema.safeParse(item.estimate).success).length;
		missingParticipantEstimates = [...new Set(workItems.filter((item) => !estimateSchema.safeParse(item.estimate).success)
			.map((item) => text(item.agentClass)).filter(Boolean))].sort((left, right) => left.localeCompare(right));
		missingReviewerClasses = exact.definition.schemaVersion !== 'treeseed.proposal/v2' && workItems.some((item) => item.review === 'required'
			&& !estimateSchema.safeParse(item.reviewEstimate).success) ? ['reviewer'] : [];
		executionPlanReady = exact.definition.status !== 'withdrawn' && hasCompleteExecutablePlan(exact.definition);
	} catch (error) {
		exactSourceProblem = text(record(error).code) || (error instanceof Error ? error.message : 'proposal_exact_source_invalid');
	}
	const missingContent = exactSourceProblem ? [`exact proposal source (${exactSourceProblem})`] : [];
	const missingVoting = [...missingContent];
	let participationVersionReady = true, authorIndependent = true;
	if (definition) try {
		const participation = await loadProposalGroupContributions(this, proposal as unknown as Row, definition);
		executionPlanReady &&= participation.current;
		if (participation.current && definition.schemaVersion === 'treeseed.proposal/v2' && exactRef) {
			projectTeamExecutionGraph({ teamId: proposal.teamId, revision: 1, profiles: participation.profiles,
				sources: [{ teamId: proposal.teamId, projectId: text(proposal.projectId), frontmatter: definition,
					repository: exactRef.repository!, commit: exactRef.commit!, path: exactRef.path!, digest: exactRef.digest!,
					proposalRevision: proposalVersion, estimatingAttempts: participation.attempts, decision: null }] });
		}
		participationVersionReady = participation.current; authorIndependent = participation.independent;
		missingParticipantEstimates = [...new Set([...missingParticipantEstimates, ...participation.missing])].sort();
		if (!participationVersionReady) missingVoting.push('contributions from every subscribed group participant for the current proposal content');
		if (!authorIndependent) missingVoting.push('author-independent group participation');
	} catch (error) {
		executionPlanReady = false;
		participationVersionReady = false; authorIndependent = false;
		missingVoting.push(`group participation (${text(record(error).code) || 'unavailable'})`);
	}
	if (!executionPlanReady) missingVoting.push('ready proposal-owned execution plan');
	if (blockers.length) missingVoting.push('resolved blocking questions and concerns');
	return {
		contentReady: missingContent.length === 0,
		votingReady: missingVoting.length === 0,
		missingContent, missingVoting,
		independentReviewCount: reviews.length,
		estimateCount,
		unresolvedBlockerCount: blockers.length,
		missingParticipantEstimates,
		missingReviewerClasses,
		participationVersionReady,
		authorIndependent,
		executionPlanReady,
	};
}

export async function assertGovernanceProposalReady(this: ControlPlaneStore, proposalId: string, stage: 'content' | 'voting') {
	const readiness = await this.governanceProposalReadiness(proposalId);
	const missing = stage === 'content' ? readiness?.missingContent : readiness?.missingVoting;
	const ready = stage === 'content' ? readiness?.contentReady : readiness?.votingReady;
	if (ready !== true || !Array.isArray(missing) || missing.length) {
		throw Object.assign(new Error(`Proposal is not ready for ${stage === 'content' ? 'discussion' : 'voting'}: ${Array.isArray(missing) ? missing.join(', ') : 'missing readiness authority'}.`),
			{ status: 409, code: 'governance_proposal_not_ready', readiness });
	}
	return readiness;
}
