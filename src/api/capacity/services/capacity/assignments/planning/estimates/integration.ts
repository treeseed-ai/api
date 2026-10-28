import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { setTimeout as delay } from 'node:timers/promises';
import { branchMovedConflict } from '../../../../../../discussions/discussion-workspace.ts';
import type { AssignmentResult, ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { assignmentAttemptSchema, estimateSchema } from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError } from '../../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../../repositories/capacity/assignments/assignment.ts';
import { hasCompleteExecutablePlan, proposalApprovalFingerprint, readExactProposal } from '../../../../../../governance/executable-proposal.ts';
import { commitProposalVersionContent } from '../../../../../../control-plane/governance/proposal-version-content.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../../knowledge/gateway-treedx-connection.ts';
import type { CapacityGovernanceDatabase } from '../../../../../database.ts';
import type { WorkdayTreeDxConnectionStore } from '../../../workdays/treedx/workday-treedx-connection.ts';
import type { ControlPlaneStore } from '../../../../../../persistence/store.ts';

type EstimateIntegrationStore = CapacityGovernanceDatabase & WorkdayTreeDxConnectionStore & Pick<ControlPlaneStore,
	'getGovernanceProposal' | 'updateGovernanceProposalDraft' | 'evaluateGovernanceProposal'>;

function requireEstimateAuthority(store: CapacityGovernanceDatabase & Partial<EstimateIntegrationStore>): asserts store is EstimateIntegrationStore {
	if (!store.config || !store.getProjectTreeDxLibrary || !store.getGovernanceProposal
		|| !store.updateGovernanceProposalDraft || !store.evaluateGovernanceProposal) throw new CapacityGovernanceError(
		'assignment_estimate_authority_unavailable', 'Estimate integration requires its original governed proposal and library authority.', 503);
}

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
	: value && typeof value === 'object' ? `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value);

function workItems(value: Row): Row[] {
	return Array.isArray(record(value.executionPlan).workItems) ? record(value.executionPlan).workItems as Row[] : [];
}

type Estimator = Pick<DurableProviderAssignment, 'id' | 'agentId' | 'teamId' | 'projectId' | 'assignmentAttempt'>;
type EstimateMerge = { frozen: Row; candidate: Row; current: Row; agentClass?: string;
	assignment?: Estimator; ownedEstimateRefs?: ExactEntityReference[] };

/** Ownership comes from the admitted attempt and canonical prior estimates.
 * Concurrent first contributions may add disjoint work; no author can alter a
 * peer's frozen work or replace a newer contribution with a stale result. */
function mergeSubscriberEstimate(input: EstimateMerge): Row {
	const assignment = input.assignment, attempt = assignment?.assignmentAttempt;
	const deny = (code: string, message: string): never => { throw new CapacityGovernanceError(code, message, 409); };
	if (!assignment || !attempt || attempt.id !== assignment.id || !assignment.agentId
		|| attempt.projectId !== assignment.projectId || attempt.teamId !== assignment.teamId
		|| attempt.effectiveProfile.activity !== 'estimating' || attempt.effectiveProfile.profileRef.id !== assignment.agentId
		|| attempt.sourceRef.store !== 'treedx' || attempt.sourceRef.model !== 'proposal' || attempt.sourceRef.id !== input.frozen.id)
		return deny('assignment_estimate_authority_invalid', 'Contribution ownership requires its actual admitted estimating attempt.');
	for (const value of [input.frozen, input.candidate, input.current]) if (value.schemaVersion !== 'treeseed.proposal/v2'
		|| !validatePortableContentData('proposal', value).ok) return deny('assignment_estimate_content_invalid',
			'Every contribution must satisfy the current group proposal contract.');
	const intent = (value: Row) => { const { executionPlan: _plan, status: _status, ...rest } = value; return rest; };
	if (stable(intent(input.candidate)) !== stable(intent(input.frozen))) return deny('assignment_estimate_unrelated_change',
		'An estimator cannot change the proposal objective, groups or other authored content.');
	if (stable(intent(input.current)) !== stable(intent(input.frozen))) return deny('assignment_estimate_source_changed',
		'The proposal objective, groups or other authored content changed after estimation began.');
	const ref: ExactEntityReference = { store: 'postgresql', model: 'assignment-attempt', id: attempt.id, revision: attempt.attempt };
	const owned = new Set([ref, ...(input.ownedEstimateRefs ?? [])].map(stable));
	const owns = (item: Row) => owned.has(stable(item.estimateRef));
	const frozenItems = workItems(input.frozen), candidateItems = workItems(input.candidate), currentItems = workItems(input.current);
	const own = candidateItems.filter(owns), peers = candidateItems.filter(item => !owns(item));
	// A new contribution must cite this attempt. Unchanged earlier own work
	// retains its actual provenance instead of being relabeled as new work.
	if (!own.some(item => stable(item.estimateRef) === stable(ref)) || own.some(item =>
		stable(item.estimateRef) !== stable(ref) && !frozenItems.some(prior => stable(prior) === stable(item)))) return deny('assignment_estimate_owner_missing',
		'Each estimating author must submit its own work with the exact current attempt provenance.');
	if (own.some(item => !estimateSchema.safeParse(item.estimate).success
		|| (item.review === 'required' && !estimateSchema.safeParse(item.reviewEstimate).success)))
		return deny('assignment_estimate_work_item_invalid', 'An estimating result must supply its actual estimate and required review estimate.');
	const ordered = (items: Row[]) => [...items].sort((left, right) => text(left.id).localeCompare(text(right.id)));
	const firstIds = new Set(own.map(item => text(item.id)));
	const planning = ['draft', 'discussing'].includes(text(input.frozen.status)) && ['draft', 'discussing'].includes(text(input.current.status));
	const firstClaim = (item: Row) => planning && firstIds.has(text(item.id)) && item.estimateRef === undefined
		&& item.estimate === undefined && item.reviewEstimate === undefined;
	for (const planned of frozenItems.filter(firstClaim)) {
		const current = currentItems.find(item => item.id === planned.id);
		if (!current || (firstClaim(current) && stable(current) !== stable(planned))) return deny('assignment_estimate_source_changed',
			'A newer discussed contribution must not be overwritten or restored by a stale first claim.');
	}
	if (stable(ordered(peers)) !== stable(ordered(frozenItems.filter(item => !owns(item) && !firstClaim(item))))) return deny('assignment_estimate_unrelated_change',
		'An estimator cannot add, remove or change another subscriber contribution.');
	// Submitted peer fields stay frozen above; preserve newer peer contributions
	// from the current plan when merging only this author's work below.
	const currentOwn = currentItems.filter(owns);
	if (stable(ordered(currentOwn)) !== stable(ordered(frozenItems.filter(owns))) && stable(ordered(currentOwn)) !== stable(ordered(own))) return deny(
		'assignment_estimate_source_changed', 'A newer contribution from this author must not be overwritten.');
	const merged = { ...input.current, executionPlan: { workItems: ordered([...currentItems.filter(item => !owns(item) && !firstClaim(item)), ...own]) } };
	if (!validatePortableContentData('proposal', merged).ok) return deny('assignment_estimate_work_item_invalid',
		'The combined contributions contain conflicting IDs, dependencies or invalid work.');
	// Workflow order is authored content. An unchanged contribution must remain
	// current without rewriting the proposal merely to alphabetize its items.
	if (stable(ordered(workItems(merged))) === stable(ordered(currentItems))) return input.current;
	return merged;
}

async function ownEstimateReferences(store: CapacityGovernanceDatabase, assignment: Estimator,
	frozen: Row, current: Row): Promise<ExactEntityReference[]> {
	const ids = [...new Set([...workItems(frozen), ...workItems(current)].map(item => text(record(item.estimateRef).id)).filter(Boolean))];
	if (!ids.length) return [];
	const values = await store.all(`SELECT id,assignment_attempt_json FROM capacity_provider_assignments
		WHERE team_id=? AND project_id=? AND agent_id=? AND id IN (${ids.map(() => '?').join(',')})`,
		[assignment.teamId, assignment.projectId, assignment.agentId, ...ids]);
	return values.flatMap(value => {
		const parsed = assignmentAttemptSchema.safeParse(record(typeof value.assignment_attempt_json === 'string'
			? JSON.parse(value.assignment_attempt_json) : value.assignment_attempt_json));
		if (!parsed.success || parsed.data.id !== value.id || parsed.data.teamId !== assignment.teamId
			|| parsed.data.projectId !== assignment.projectId || parsed.data.effectiveProfile.profileRef.id !== assignment.agentId
			|| parsed.data.effectiveProfile.activity !== 'estimating' || parsed.data.sourceRef.model !== 'proposal'
			|| parsed.data.sourceRef.id !== frozen.id) return [];
		return [{ store: 'postgresql', model: 'assignment-attempt', id: parsed.data.id, revision: parsed.data.attempt }];
	});
}

/** Current group contributions use actual attempt custody. The v1 branch is
 * retained only for already-issued historical authority during migration. */
export function mergeAssignmentEstimate(input: {
	frozen: Row; candidate: Row; current: Row; agentClass?: string;
	assignment?: Estimator; ownedEstimateRefs?: ExactEntityReference[];
}): Row {
	if (input.frozen.schemaVersion === 'treeseed.proposal/v2') return mergeSubscriberEstimate(input);
	const frozenItems = workItems(input.frozen);
	const candidateItems = workItems(input.candidate);
	const currentItems = workItems(input.current);
	const reviewer = input.agentClass === 'reviewer';
	const targets = frozenItems.flatMap((item, index) => (reviewer ? item.review === 'required'
		: item.agentClass === input.agentClass) ? [index] : []);
	if (!targets.length || frozenItems.length !== candidateItems.length || frozenItems.length !== currentItems.length
		|| new Set(frozenItems.map((item) => item.id)).size !== frozenItems.length) {
		throw new CapacityGovernanceError('assignment_estimate_work_item_invalid', 'Estimator result has no class-owned frozen proposal work items.', 409);
	}
	const withoutEstimate = (item: Row): Row => { const { estimate: _estimate, reviewEstimate: _reviewEstimate, ...rest } = item; return rest; };
	if (stable({ ...input.candidate, executionPlan: { ...record(input.candidate.executionPlan), workItems: candidateItems.map(withoutEstimate) } })
		!== stable({ ...input.frozen, executionPlan: { ...record(input.frozen.executionPlan), workItems: frozenItems.map(withoutEstimate) } })) {
		throw new CapacityGovernanceError('assignment_estimate_unrelated_change', 'Estimator result changed proposal fields outside its assigned estimate.', 409);
	}
	if (candidateItems.some((item, itemIndex) =>
		stable(reviewer ? item.estimate : item.reviewEstimate) !== stable(reviewer ? frozenItems[itemIndex].estimate : frozenItems[itemIndex].reviewEstimate)
		|| (!targets.includes(itemIndex) && stable(item[reviewer ? 'reviewEstimate' : 'estimate'])
			!== stable(frozenItems[itemIndex][reviewer ? 'reviewEstimate' : 'estimate'])))) {
		throw new CapacityGovernanceError('assignment_estimate_unrelated_change', 'Estimator result changed another work item estimate.', 409);
	}
	if (proposalApprovalFingerprint(input.current) !== proposalApprovalFingerprint(input.frozen)) {
		throw new CapacityGovernanceError('assignment_estimate_source_changed', 'Current proposal authority no longer matches the frozen assignment source.', 409);
	}
	const field = reviewer ? 'reviewEstimate' : 'estimate';
	for (const target of targets) {
		const estimate = record(candidateItems[target][field]);
		if (!Object.keys(estimate).length || !text(estimate.rationale)) throw new CapacityGovernanceError(
			'assignment_estimate_missing', 'Estimator result must include a structured estimate and rationale for each assigned work item.', 409);
		// Estimates remain class-owned and mutable throughout planning. The living
		// graph serializes each class's rounds, so a later authorized turn may refine
		// its prior value after seeing predecessor contributions. Proposal decision
		// closes this path; unrelated classes and fields remain rejected above.
	}
	return { ...input.current, executionPlan: { ...record(input.current.executionPlan),
		workItems: currentItems.map((item, itemIndex) => targets.includes(itemIndex)
			? { ...item, [field]: candidateItems[itemIndex][field] } : item) } };
}

/** TreeDX's existing writable branch lease serializes publication. Re-read and
 * merge after contention; never replay the stale proposal version as-is. */
export async function retryEstimateContention(write: () => Promise<void>, input: {
	deadlineMs: number; now?: () => number; wait?: (ms: number) => Promise<void>;
}): Promise<void> {
	const now = input.now ?? Date.now, wait = input.wait ?? ((ms: number) => delay(ms));
	for (;;) {
		try { await write(); return; }
		catch (error) {
			const failure = error as { status?: number; message?: string };
			if (!(branchMovedConflict(error) || (failure.status === 409 && /\bconflict: writable lease already exists for /u.test(String(failure.message ?? ''))))
				|| now() + 250 >= input.deadlineMs) throw error;
			await wait(250);
		}
	}
}

export async function integrateAssignmentEstimate(
	store: CapacityGovernanceDatabase & Partial<EstimateIntegrationStore>, assignment: DurableProviderAssignment, result: AssignmentResult,
): Promise<void> {
	if (assignment.assignmentAttempt?.effectiveProfile.activity !== 'estimating') return;
	const leaseExpiry = Date.parse(assignment.leaseExpiresAt ?? '');
	const deadlineMs = Math.min(Date.now() + 10_000, Number.isFinite(leaseExpiry) ? leaseExpiry - 1_000 : Infinity);
	await retryEstimateContention(() => integrateAssignmentEstimateOnce(store, assignment, result), { deadlineMs });
}

export async function finalizeEstimateReadyApproval(store: Pick<EstimateIntegrationStore, 'first'> & {
	evaluateGovernanceProposal(proposalId: string, input: Row): Promise<unknown>;
}, proposalId: string, definition: Row): Promise<boolean> {
	if (definition.status === 'withdrawn' || !hasCompleteExecutablePlan(definition)) return false;
	const approval = await store.first(`SELECT actor_id, evidence_json FROM governance_events
		WHERE proposal_id=? AND event_type IN ('proposal.admin_decision','proposal.simulated_human_decision')
		ORDER BY created_at DESC, id DESC LIMIT 1`, [proposalId]);
	const evidence = typeof approval?.evidence_json === 'string'
		? record(JSON.parse(approval.evidence_json)) : record(approval?.evidence_json);
	if (!approval || evidence.pendingEstimates !== true || evidence.approvalFingerprint !== proposalApprovalFingerprint(definition)) return false;
	await store.evaluateGovernanceProposal(proposalId, {
		adminDecision: 'approved', actorType: 'user', actorId: text(approval.actor_id),
	});
	return true;
}

async function integrateAssignmentEstimateOnce(
	store: CapacityGovernanceDatabase & Partial<EstimateIntegrationStore>, assignment: DurableProviderAssignment, result: AssignmentResult,
): Promise<void> {
	const attempt = assignment.assignmentAttempt;
	if (!attempt || attempt.sourceRef.model !== 'proposal' || !assignment.agentId) throw new CapacityGovernanceError(
		'assignment_estimate_source_missing', 'Estimating assignment lacks a frozen proposal, work item, or agent.', 409);
	if (!store.getGovernanceProposal) throw new CapacityGovernanceError(
		'assignment_estimate_authority_unavailable', 'Estimate integration requires governed proposal authority.', 503);
	const proposal = await store.getGovernanceProposal(attempt.sourceRef.id);
	if (!proposal || proposal.teamId !== assignment.teamId) throw new CapacityGovernanceError(
		'assignment_estimate_proposal_mismatch', 'Estimating assignment proposal is outside its team.', 409);
	if (!['draft', 'submitted', 'open'].includes(text(proposal.status))) throw new CapacityGovernanceError(
		'assignment_estimate_proposal_closed', 'Estimating cannot update a proposal after voting or decision.', 409);
	requireEstimateAuthority(store);
	const frozen = await readExactProposal(store, proposal, attempt.sourceRef);
	if (proposal.projectId !== assignment.projectId && frozen.definition.schemaVersion !== 'treeseed.proposal/v2') throw new CapacityGovernanceError(
		'assignment_estimate_proposal_mismatch', 'Retained class-owned estimates cannot cross their original project.', 409);
	const current = await readExactProposal(store, proposal);
	if (['withdrawn', 'decided'].includes(text(current.definition.status))) throw new CapacityGovernanceError(
		'assignment_estimate_proposal_closed', 'The current proposal is closed to new contributions.', 409);
	const candidate = await readAssignmentEstimateProposal(store, assignment, result);
	const contributions = frozen.definition.schemaVersion === 'treeseed.proposal/v2';
	const merged = mergeAssignmentEstimate({ frozen: frozen.definition, candidate, current: current.definition,
		agentClass: attempt.agentClass, assignment,
		ownedEstimateRefs: contributions ? await ownEstimateReferences(store, assignment, frozen.definition, current.definition) : [] });
	if (stable(merged) === stable(current.definition)) return;
	// A contribution's presence cannot stand in for the whole group's completion.
	// The canonical readiness gate checks genuine completed attempts after their
	// results/read-back are committed; never mark the first v2 item ready here.
	const allEstimated = !contributions && workItems(merged).every((item) => Object.keys(record(item.estimate)).length > 0
		&& (item.review !== 'required' || Object.keys(record(item.reviewEstimate)).length > 0));
	const authored = await commitProposalVersionContent({ store, proposal,
		principal: { id: assignment.agentId, name: assignment.agentId },
		update: { title: proposal.title, summary: proposal.summary, body: proposal.body,
			proposalTypes: proposal.proposalTypes, status: allEstimated ? 'ready' : merged.status,
			groupIds: merged.groupIds, objectiveRefs: merged.objectiveRefs, evidenceRefs: merged.evidenceRefs,
			discussionRef: merged.discussionRef, executionPlan: merged.executionPlan,
			workdayId: assignment.workDayId, expectedProposalVersion: proposal.activeVersion,
			changeReason: `Integrate ${assignment.agentId} contribution from assignment ${assignment.id}.` } });
	await store.updateGovernanceProposalDraft({ id: assignment.agentId, scopes: [], roles: [], permissions: [] }, text(proposal.id),
		{ ...authored.update, createdByType: 'agent', createdById: assignment.agentId });
	if (allEstimated) await finalizeEstimateReadyApproval(store, text(proposal.id), merged);
}

/** One exact native read boundary serves estimate integration and readiness. */
export async function readAssignmentEstimateProposal(store: CapacityGovernanceDatabase, assignment: Estimator, result: AssignmentResult): Promise<Row> {
	const attempt = assignment.assignmentAttempt;
	if (!attempt || result.assignmentId !== assignment.id || result.status !== 'completed') throw new CapacityGovernanceError(
		'assignment_estimate_result_invalid', 'Estimate read-back requires the actual attempt and its completed result.', 409);
	const matches = result.references.filter((reference): reference is Extract<AssignmentResult['references'][number], { kind: 'treedx' }> => reference.kind === 'treedx'
		&& reference.repository === attempt.sourceRef.repository
		&& reference.path === attempt.sourceRef.path);
	if (matches.length !== 1) throw new CapacityGovernanceError('assignment_estimate_reference_invalid',
		'Estimator result must cite exactly one proposal commit in its authorized project library.', 409);
	const reference = matches[0]!;
	const crossProject = reference.projectId !== assignment.projectId;
	if (crossProject) {
		const owner = await store.first('SELECT team_id,project_id FROM governance_proposals WHERE id=?', [attempt.sourceRef.id]);
		if (!owner || owner.team_id !== assignment.teamId || owner.project_id !== reference.projectId) throw new CapacityGovernanceError(
			'assignment_estimate_proposal_mismatch', 'A contribution must cite the proposal owner in its admitted team.', 409);
		if (!attempt.grant.contentWrite.some(grant => grant.store === 'treedx' && grant.model === 'proposal'
			&& grant.id === attempt.sourceRef.id && grant.repository === reference.repository && grant.path === reference.path
			&& grant.commit === attempt.sourceRef.commit)) throw new CapacityGovernanceError('assignment_estimate_reference_invalid',
			'Cross-project estimation requires the exact admitted proposal write grant.', 409);
	}
	if (attempt.workspace.mode !== 'treedx' || reference.workspaceId !== attempt.workspace.workspaceId) throw new CapacityGovernanceError(
		'assignment_estimate_workspace_mismatch', 'Estimator result did not originate from its authorized workspace.', 409);
	const connection = await resolveKnowledgeGatewayConnection(store, { projectId: reference.projectId,
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
		`Estimator proposal content is invalid: ${parsed.diagnostics.slice(0, 5)
			.map((diagnostic) => `${diagnostic.field ?? 'document'}:${diagnostic.code}`).join(', ') || 'missing data'}.`,
		409, { diagnostics: parsed.diagnostics });
	const definition = record(parsed.data);
	if (definition.id !== attempt.sourceRef.id || definition.projectId !== reference.projectId
		|| (crossProject && definition.schemaVersion !== 'treeseed.proposal/v2')) throw new CapacityGovernanceError(
		'assignment_estimate_content_invalid', 'Estimate content must retain its exact proposal identity and owning project.', 409);
	return definition;
}

export async function isCurrentSubscriberContribution(store: CapacityGovernanceDatabase, proposal: Row, current: Row,
	assignment: Estimator, result: AssignmentResult): Promise<boolean> {
	const attempt = assignment.assignmentAttempt;
	if (!attempt || !workItems(current).some(item => stable(item.estimateRef) === stable({
		store: 'postgresql', model: 'assignment-attempt', id: attempt.id, revision: attempt.attempt }))) return false;
	let frozen: Awaited<ReturnType<typeof readExactProposal>>;
	try { frozen = await readExactProposal(store, proposal, attempt.sourceRef); }
	catch (error) {
		// Retain obsolete estimating history without treating it as a current
		// subscriber contribution. Exact-ref, authority and availability failures
		// still propagate; only a verified schema rejection is noncurrent.
		const failure = record(error);
		if (failure.status === 422 && failure.code === 'proposal_execution_plan_invalid') return false;
		throw error;
	}
	const candidate = await readAssignmentEstimateProposal(store, assignment, result);
	try {
		return stable(mergeSubscriberEstimate({ frozen: frozen.definition, current, candidate, assignment,
			ownedEstimateRefs: await ownEstimateReferences(store, assignment, frozen.definition, current) })) === stable(current);
	} catch (error) {
		if (error instanceof CapacityGovernanceError && error.code.startsWith('assignment_estimate_')) return false;
		throw error;
	}
}
