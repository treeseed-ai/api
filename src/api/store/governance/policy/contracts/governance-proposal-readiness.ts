import type { GovernanceProposalReadiness } from '../../../../governance/proposal-readiness.ts';
import type { ControlPlaneStore } from '../../../../persistence/store.ts';
import { assignmentAttemptSchema, assignmentResultSchema, estimateSchema } from '@treeseed/sdk/agent-capacity';
import { hasCompleteExecutablePlan, proposalApprovalFingerprint, readExactProposal } from '../../../../governance/executable-proposal.ts';
import { loadProposalBlockingFeedback } from '../../../../capacity/services/capacity/execution/proposal-planning-source.ts';
import { resolveWorkdayAgentProfileSnapshot } from '../../../../capacity/services/capacity/workdays/policy/workday-agent-profile-policy.ts';
import { isDeepStrictEqual } from 'node:util';

type Row = Record<string, unknown>;
function record(value: unknown): Row { if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row; if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; } return {}; }
function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }

async function groupParticipation(store: ControlPlaneStore, proposal: Row, definition: Row) {
	const groups = Array.isArray(definition.groupIds) ? definition.groupIds.map(text) : [];
	if (!groups.length) return { missing: [] as string[], current: true, independent: true };
	const projects = await store.listTeamProjects(text(proposal.teamId));
	const members = (await Promise.all(projects.map(async project => {
		try {
			const snapshot = await resolveWorkdayAgentProfileSnapshot(store, project.id, undefined, groups);
			return snapshot.agents.filter(entry => entry.definition.groupIds?.some(id => groups.includes(id))
				&& (entry.definition.activityProfiles.planning || entry.definition.activityProfiles.estimating))
				.map(entry => ({ key: `${project.id}/${entry.definition.id}`, id: entry.definition.id, agentClass: entry.definition.agentClass }));
		} catch (error) {
			if (record(error).code === 'capacity_workday_agent_selection_empty') return [];
			throw error;
		}
	}))).flat();
	const required = new Map(members.map(member => [member.key, member]));
	const completed = new Set<string>();
	const rows = await store.all(`SELECT assignment.id,assignment.assignment_attempt_json,assignment.assignment_result_json,audit.data_json AS integration_json
		FROM capacity_provider_assignments assignment JOIN audit_events audit ON audit.target_id=assignment.id
		AND audit.target_type='capacity_provider_assignment' AND audit.event_type='assignment.content.integrated'
		WHERE assignment.team_id=? AND assignment.status='completed'
		AND assignment.assignment_attempt_json::jsonb #>> '{sourceRef,model}'='proposal'
		AND assignment.assignment_attempt_json::jsonb #>> '{sourceRef,id}'=?
		AND assignment.assignment_attempt_json::jsonb #>> '{effectiveProfile,activity}' IN ('planning','estimating')
		ORDER BY assignment.completed_at,assignment.id`, [text(proposal.teamId), text(proposal.id)]);
	const fingerprint = proposalApprovalFingerprint(definition), sources = new Map<string, string>();
	for (const row of rows) {
		const attempt = assignmentAttemptSchema.safeParse(record(row.assignment_attempt_json));
		const result = assignmentResultSchema.safeParse(record(row.assignment_result_json));
		if (!attempt.success || !result.success || result.data.status !== 'completed' || result.data.assignmentId !== row.id
			|| attempt.data.id !== row.id) continue;
		const key = `${attempt.data.projectId}/${attempt.data.effectiveProfile.profileRef.id}`, member = required.get(key);
		if (!member || member.agentClass !== attempt.data.agentClass) continue;
		const integrated = record(row.integration_json);
		if (integrated.resultId !== result.data.id || !isDeepStrictEqual(integrated.references, result.data.references)) continue;
		const sourceKey = JSON.stringify(attempt.data.sourceRef);
		if (!sources.has(sourceKey)) sources.set(sourceKey,
			proposalApprovalFingerprint((await readExactProposal(store, proposal, attempt.data.sourceRef)).definition));
		if (sources.get(sourceKey) === fingerprint) completed.add(key);
	}
	const missing = [...required.keys()].filter(key => !completed.has(key)).sort();
	if (!required.size) missing.push('shared group subscribers');
	return { missing, current: missing.length === 0,
		independent: [...completed].some(key => required.get(key)!.id !== text(proposal.createdById)) };
}

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
	if (proposal.projectId) try {
		const exact = await readExactProposal(this, proposal as unknown as Row);
		definition = exact.definition;
		const plan = record(exact.definition.executionPlan);
		const workItems = Array.isArray(plan.workItems) ? plan.workItems.map(record) : [];
		estimateCount = workItems.filter((item) => estimateSchema.safeParse(item.estimate).success).length;
		missingParticipantEstimates = [...new Set(workItems.filter((item) => !estimateSchema.safeParse(item.estimate).success)
			.map((item) => text(item.agentClass)).filter(Boolean))].sort((left, right) => left.localeCompare(right));
		missingReviewerClasses = workItems.some((item) => item.review === 'required'
			&& !estimateSchema.safeParse(item.reviewEstimate).success) ? ['reviewer'] : [];
		executionPlanReady = exact.definition.status !== 'withdrawn' && hasCompleteExecutablePlan(exact.definition);
	} catch (error) {
		exactSourceProblem = text(record(error).code) || (error instanceof Error ? error.message : 'proposal_exact_source_invalid');
	}
	const missingContent = exactSourceProblem ? [`exact proposal source (${exactSourceProblem})`] : [];
	const missingVoting = [...missingContent];
	let participationVersionReady = true, authorIndependent = true;
	if (definition) try {
		const participation = await groupParticipation(this, proposal as unknown as Row, definition);
		participationVersionReady = participation.current; authorIndependent = participation.independent;
		missingParticipantEstimates = [...new Set([...missingParticipantEstimates, ...participation.missing])].sort();
		if (!participationVersionReady) missingVoting.push('contributions from every subscribed group participant for the current proposal content');
		if (!authorIndependent) missingVoting.push('author-independent group participation');
	} catch (error) {
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
