import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import type { AssignmentResult } from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError } from '../../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../../repositories/capacity/assignments/assignment.ts';
import { readExactProposal } from '../../../../../../governance/executable-proposal.ts';
import { commitProposalVersionContent } from '../../../../../../control-plane/governance/proposal-version-content.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../../knowledge/gateway-treedx-connection.ts';
import type { AssignmentPlanningOutputStore } from '../assignment-planning-output-service.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
	: value && typeof value === 'object' ? `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value);

function workItems(value: Row): Row[] {
	return Array.isArray(record(value.executionPlan).workItems) ? record(value.executionPlan).workItems as Row[] : [];
}

/** One estimate belongs to the exact work item selected by the graph, not to a new plan authority. */
export function mergeAssignmentEstimate(input: {
	frozen: Row; candidate: Row; current: Row; workItemId: string | null;
}): Row {
	const frozenItems = workItems(input.frozen);
	const candidateItems = workItems(input.candidate);
	const currentItems = workItems(input.current);
	const reviewer = input.workItemId === null;
	const index = reviewer ? -1 : frozenItems.findIndex((item) => item.id === input.workItemId);
	if ((!reviewer && index < 0) || !frozenItems.length || frozenItems.length !== candidateItems.length || frozenItems.length !== currentItems.length
		|| new Set(frozenItems.map((item) => item.id)).size !== frozenItems.length) {
		throw new CapacityGovernanceError('assignment_estimate_work_item_invalid', 'Estimator result does not target one frozen proposal work item.', 409);
	}
	const withoutEstimate = (item: Row): Row => { const { estimate: _estimate, reviewEstimate: _reviewEstimate, ...rest } = item; return rest; };
	if (stable({ ...input.candidate, executionPlan: { ...record(input.candidate.executionPlan), workItems: candidateItems.map(withoutEstimate) } })
		!== stable({ ...input.frozen, executionPlan: { ...record(input.frozen.executionPlan), workItems: frozenItems.map(withoutEstimate) } })) {
		throw new CapacityGovernanceError('assignment_estimate_unrelated_change', 'Estimator result changed proposal fields outside its assigned estimate.', 409);
	}
	if (candidateItems.some((item, itemIndex) =>
		stable(reviewer ? item.estimate : item.reviewEstimate) !== stable(reviewer ? frozenItems[itemIndex].estimate : frozenItems[itemIndex].reviewEstimate)
		|| (!reviewer && itemIndex !== index && stable(item.estimate) !== stable(frozenItems[itemIndex].estimate)))) {
		throw new CapacityGovernanceError('assignment_estimate_unrelated_change', 'Estimator result changed another work item estimate.', 409);
	}
	if (currentItems.some((item, itemIndex) => item.id !== frozenItems[itemIndex].id
		|| stable(withoutEstimate(item)) !== stable(withoutEstimate(frozenItems[itemIndex])))) {
		throw new CapacityGovernanceError('assignment_estimate_source_changed', 'Current proposal work items no longer match the frozen assignment source.', 409);
	}
	const field = reviewer ? 'reviewEstimate' : 'estimate';
	const targets = reviewer ? frozenItems.map((_, itemIndex) => itemIndex) : [index];
	for (const target of targets) {
		const estimate = record(candidateItems[target][field]);
		if (!Object.keys(estimate).length || !text(estimate.rationale)) throw new CapacityGovernanceError(
			'assignment_estimate_missing', 'Estimator result must include a structured estimate and rationale for each assigned work item.', 409);
		const existing = currentItems[target][field];
		if (existing !== undefined && stable(existing) !== stable(estimate)) throw new CapacityGovernanceError(
			'assignment_estimate_conflict', 'The assigned work item already has a different estimate.', 409);
	}
	return { ...input.current, executionPlan: { ...record(input.current.executionPlan),
		workItems: currentItems.map((item, itemIndex) => targets.includes(itemIndex)
			? { ...item, [field]: candidateItems[itemIndex][field] } : item) } };
}

export async function integrateAssignmentEstimate(
	store: AssignmentPlanningOutputStore, assignment: DurableProviderAssignment, result: AssignmentResult,
): Promise<void> {
	if (assignment.assignmentAttempt?.effectiveProfile.activity !== 'estimating') return;
	const attempt = assignment.assignmentAttempt;
	if (attempt.sourceRef.model !== 'proposal' || !assignment.agentId) throw new CapacityGovernanceError(
		'assignment_estimate_source_missing', 'Estimating assignment lacks a frozen proposal, work item, or agent.', 409);
	const proposal = await store.getGovernanceProposal(attempt.sourceRef.id);
	if (!proposal || proposal.projectId !== assignment.projectId || proposal.teamId !== assignment.teamId) throw new CapacityGovernanceError(
		'assignment_estimate_proposal_mismatch', 'Estimating assignment proposal is outside its project and team.', 409);
	if (!['draft', 'submitted', 'open'].includes(text(proposal.status))) throw new CapacityGovernanceError(
		'assignment_estimate_proposal_closed', 'Estimating cannot update a proposal after voting or decision.', 409);
	const frozen = await readExactProposal(store, proposal, attempt.sourceRef);
	const current = await readExactProposal(store, proposal);
	const matches = result.references.filter((reference): reference is Extract<AssignmentResult['references'][number], { kind: 'treedx' }> => reference.kind === 'treedx'
		&& reference.projectId === assignment.projectId && reference.repository === attempt.sourceRef.repository
		&& reference.path === attempt.sourceRef.path);
	if (matches.length !== 1) throw new CapacityGovernanceError('assignment_estimate_reference_invalid',
		'Estimator result must cite exactly one proposal commit in its authorized project library.', 409);
	const reference = matches[0]!;
	if (attempt.workspace.mode !== 'treedx' || reference.workspaceId !== attempt.workspace.workspaceId) throw new CapacityGovernanceError(
		'assignment_estimate_workspace_mismatch', 'Estimator result did not originate from its authorized workspace.', 409);
	const connection = await resolveKnowledgeGatewayConnection(store, { projectId: assignment.projectId,
		write: false, relationPaths: true, readRefs: [reference.commit] });
	if (!connection || connection.repositoryId !== reference.repository) throw new CapacityGovernanceError(
		'assignment_estimate_repository_changed', 'Estimator proposal repository binding changed.', 409);
	const response = record(await connection.client.readRepositoryFile({ repoId: reference.repository,
		ref: reference.commit, path: reference.path, encoding: 'utf8', parseFrontmatter: true, allowProtected: true }));
	if (text(response.resolvedRef) !== reference.commit) throw new CapacityGovernanceError(
		'assignment_estimate_ref_moved', 'Estimator proposal result did not resolve to its exact commit.', 409);
	const file = record(response.file ?? (Array.isArray(response.files) ? response.files[0] : null));
	const source = text(file.content);
	if (!source) throw new CapacityGovernanceError(
		'assignment_estimate_content_missing', 'Estimator proposal result has no content.', 409);
	const parsed = validatePortableContentData('proposal', record(file.frontmatter));
	if (!parsed.ok || !parsed.data) throw new CapacityGovernanceError('assignment_estimate_content_invalid',
		'Estimator proposal content is invalid.', 409, { diagnostics: parsed.diagnostics });
	const candidate = parsed.data as Row;
	const merged = mergeAssignmentEstimate({ frozen: frozen.definition, candidate, current: current.definition,
		workItemId: attempt.workItemId ?? null });
	if (stable(merged) === stable(current.definition)) return;
	const allEstimated = workItems(merged).every((item) => Object.keys(record(item.estimate)).length > 0
		&& (item.review !== 'required' || Object.keys(record(item.reviewEstimate)).length > 0));
	const authored = await commitProposalVersionContent({ store, proposal,
		principal: { id: assignment.agentId, name: assignment.agentId },
		update: { title: proposal.title, summary: proposal.summary, body: proposal.body,
			proposalTypes: proposal.proposalTypes, status: allEstimated ? 'ready' : merged.status,
			objectiveRefs: merged.objectiveRefs, evidenceRefs: merged.evidenceRefs,
			discussionRef: merged.discussionRef, executionPlan: merged.executionPlan,
			workdayId: assignment.workDayId, expectedProposalVersion: proposal.activeVersion,
			changeReason: `Integrate ${attempt.workItemId ?? 'review'} estimate from assignment ${assignment.id}.` } });
	await store.updateGovernanceProposalDraft({ id: assignment.agentId, type: 'agent' }, text(proposal.id),
		{ ...authored.update, createdByType: 'agent', createdById: assignment.agentId });
}
