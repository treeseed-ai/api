import { evaluateGovernanceProposalReadiness } from '../../../../../governance/proposal-readiness.ts';
import type { AgentArtifactManifest,CapacityWorkdayRunRecord } from '@treeseed/sdk/agent-capacity';
import { validateAgentArtifactManifest } from '../../../../artifact-manifest.ts';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { createHash } from 'node:crypto';
import { CapacityGovernanceError,type CapacityGovernanceDatabase } from '../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import { assignmentArtifactManifest } from '../context/assignment-deliverable-service.ts';
import { resolveWorkdayTreeDxConnection,type WorkdayTreeDxConnectionStore } from '../../workdays/treedx/workday-treedx-connection.ts';
import { resolveProposalFeedbackSubject, reviewedProposalVersion } from './feedback/subject.ts';
import { decodeWorkdayAgentProfileSnapshot } from '../../workdays/policy/workday-agent-profile-policy.ts';

type JsonRecord = Record<string, unknown>;

export interface AssignmentPlanningOutputStore extends CapacityGovernanceDatabase,WorkdayTreeDxConnectionStore {
	getGovernanceProposal(id: string): Promise<JsonRecord | null>;
	createGovernanceProposal(principal: unknown, input: JsonRecord): Promise<JsonRecord | null>;
	updateGovernanceProposalDraft(principal: unknown,proposalId: string,input: JsonRecord): Promise<JsonRecord | null>;
	getCapacityWorkdayRun(teamId: string, runId: string): Promise<CapacityWorkdayRunRecord | null>;
	recordGovernanceEvent(input: JsonRecord): Promise<JsonRecord | null>;
}

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(...values: unknown[]): string {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return '';
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : [];
}

function slug(value: string): string {
	return value.replace(/^proposal:/u, '').replace(/^.*\//u, '').replace(/\.(?:md|mdx)$/iu, '');
}

/** Resolve the activity payload from the durable assignment envelope.
 *
 * Living execution-node assignments deliberately retain the original
 * decision input inside the admission envelope. Planning-output validation
 * must bind artifacts against that inner immutable input, not against the
 * admission wrapper.
 */
export function assignmentActivityInput(assignment: DurableProviderAssignment): JsonRecord {
	const envelopeInput = record(record(assignment.decisionInput).input);
	const activityInput = record(record(envelopeInput.decisionInput).input);
	return Object.keys(activityInput).length ? activityInput : envelopeInput;
}

function proposalRevisionBases(assignment: DurableProviderAssignment) {
	const input = assignmentActivityInput(assignment);
	const intent = record(input.intent);
	const candidates = [intent.relatedArtifact,...(Array.isArray(intent.relatedArtifacts) ? intent.relatedArtifacts : [])].map(record);
	return new Set(candidates.flatMap((candidate) => [
		text(candidate.commitSha),text(candidate.version),text(candidate.digest),
	]).filter(Boolean));
}

export async function persistAssignmentProposalRevision(input: {
	store: AssignmentPlanningOutputStore;
	assignment: DurableProviderAssignment;
	existing: JsonRecord;
	proposalId: string;
	digest: string;
	contentProvenance: JsonRecord;
	proposal: JsonRecord;
}) {
	const existingMetadata = record(input.existing.metadata);
	const existingProvenance = record(existingMetadata.contentProvenance);
	if (text(existingProvenance.digest) === input.digest) return input.existing;
	const bases = proposalRevisionBases(input.assignment);
	const currentBase = [text(existingProvenance.commitSha),text(existingProvenance.digest)].filter(Boolean);
	if (!currentBase.some((value) => bases.has(value))) throw new CapacityGovernanceError(
		'assignment_proposal_revision_stale',
		'Proposal revision was not produced from the current immutable proposal version.',
		409,
		{ assignmentId: input.assignment.id,proposalId: input.proposalId,currentVersion: input.existing.activeVersion ?? null },
	);
	try {
		return await input.store.updateGovernanceProposalDraft({ id: input.assignment.agentId,type: 'agent' },input.proposalId,{
			...input.proposal,
			expectedProposalVersion: Number(input.existing.activeVersion),
			changeReason: text(input.proposal.changeReason,input.proposal.revisionSummary,`Agent ${input.assignment.agentId} published a provenance-linked revision.`),
			contentProvenance: input.contentProvenance,
			createdByType: 'agent',createdById: input.assignment.agentId,
			metadata: { ...record(input.proposal.metadata),authorAgentId: input.assignment.agentId,assignmentId: input.assignment.id,workdayId: input.assignment.workDayId },
		});
	} catch (error) {
		const current = await input.store.getGovernanceProposal(input.proposalId);
		if (current && text(record(record(current.metadata).contentProvenance).digest) === input.digest) return current;
		throw error;
	}
}

export function assignmentWorkdayRunId(assignment: DurableProviderAssignment): string {
	return text(record(assignment.metadata).workdayRunId, record(assignment.metadata).workday_run_id, assignment.workDayId);
}

function proposalParticipation(workday: unknown, projectId: string, proposalTypes: string[]) {
	const snapshot = decodeWorkdayAgentProfileSnapshot(record(record(record(workday).parameters).agentProfilesByProjectId)[projectId], projectId);
	const agents = snapshot.agents as unknown[];
	const contracts = record(snapshot.proposalTypeContracts);
	const missingTypes = proposalTypes.filter((id) => !contracts[id]);
	if (missingTypes.length) throw new CapacityGovernanceError('assignment_proposal_type_not_frozen', 'Agent proposal output contains a type outside the immutable workday contracts.', 409, { projectId, proposalTypes: missingTypes });
	const requiredClasses = new Set(proposalTypes.flatMap((id) => strings(record(contracts[id]).requiredReviewerClasses)));
	const reviewerParticipants = agents.map(record).filter((agent) => requiredClasses.has(text(agent.projectAgentClassSlug)) && ['estimating','reviewing'].includes(text(agent.activityType))).map((agent) => text(agent.slug)).filter(Boolean);
	const represented = new Set(agents.map(record).filter((agent) => reviewerParticipants.includes(text(agent.slug))).map((agent) => text(agent.projectAgentClassSlug)));
	const missingReviewerClasses = [...requiredClasses].filter((id) => !represented.has(id));
	if (missingReviewerClasses.length) throw new CapacityGovernanceError('assignment_proposal_reviewer_unavailable', 'The workday graph cannot satisfy the proposal type reviewer contract.', 409, { projectId, proposalTypes, missingReviewerClasses });
	return { participantIds: reviewerParticipants.sort(), requiredReviewerClasses: [...requiredClasses].sort(), participationSnapshot: null };
}

function repositoryFile(response: { files?: unknown[]; results?: unknown[]; file?: unknown }): JsonRecord {
	return record(response.files?.[0] ?? response.results?.[0] ?? response.file);
}

export function assertPlanningArtifactContent(model: string,path: string,frontmatter: JsonRecord,assignmentId: string) {
	const validation = validatePortableContentData(model,frontmatter);
	if (!validation.portable || !validation.ok) throw new CapacityGovernanceError('assignment_content_model_invalid', 'Planning artifact content failed model validation.', 409, {
		assignmentId,contentPath:path,model,diagnostics:validation.diagnostics,
	});
}

function planningManifest(assignment: DurableProviderAssignment,input: JsonRecord): AgentArtifactManifest | null {
	const manifest = assignmentArtifactManifest(input);
	if (!manifest) return null;
	const validation = validateAgentArtifactManifest(manifest);
	if (!validation.ok) throw new CapacityGovernanceError('assignment_artifact_manifest_invalid', validation.reason ?? 'Planning artifact manifest is invalid.', 409, { assignmentId: assignment.id });
	const expected = { assignmentId: assignment.id, projectId: assignment.projectId, teamId: assignment.teamId, mode: 'planning',
		agentClassId: assignment.projectAgentClassId, agentId: assignment.agentId ?? null };
	const actual = { assignmentId: manifest.assignmentId, projectId: manifest.projectId, teamId: manifest.teamId, mode: manifest.mode,
		agentClassId: manifest.agentClassId, agentId: manifest.agentId };
	const mismatches = Object.keys(expected).filter((key) => expected[key as keyof typeof expected] !== actual[key as keyof typeof actual]
		&& !(key === 'agentId' && expected.agentId === null));
	if (mismatches.length) {
		const differences = mismatches.map((key) => `${key} (expected=${JSON.stringify(expected[key as keyof typeof expected])}, actual=${JSON.stringify(actual[key as keyof typeof actual])})`);
		throw new CapacityGovernanceError('assignment_artifact_manifest_scope_invalid', `Planning artifact manifest scope does not match the completing assignment: ${differences.join(', ')}.`, 409,
			{ assignmentId: assignment.id, mismatches, expected, actual });
	}
	return manifest;
}

async function registerProposalArtifacts(
	store: AssignmentPlanningOutputStore,
	assignment: DurableProviderAssignment,
	manifest: AgentArtifactManifest | null,
) {
	if (!manifest) return [];
	const proposalReferences = manifest.contentReferences.filter((reference) => reference.model === 'proposal' || reference.artifactKind === 'planning_proposal');
	const feedbackReferences = manifest.contentReferences.filter((reference) => reference.artifactKind === 'proposal_feedback_note'
		|| (reference.model === 'question' && reference.subjectField === 'relatedProposals' && Boolean(reference.subjectId)));
	const executionPlanReferences = manifest.contentReferences.filter((reference) => reference.model === 'execution_plan' || reference.artifactKind === 'execution_plan');
	if (!proposalReferences.length && !feedbackReferences.length && !executionPlanReferences.length) return [];
	if (!assignment.workDayId) throw new CapacityGovernanceError('assignment_proposal_workday_missing', 'Proposal output requires durable workday provenance.', 409, { assignmentId: assignment.id });
	const connection = await resolveWorkdayTreeDxConnection(store, {
		projectId: assignment.projectId, runId: assignment.workDayId, capabilities: ['repos:read','files:read'],
	});
	if (!connection) throw new CapacityGovernanceError('assignment_proposal_treedx_unavailable', 'Proposal output could not be read through the project TreeDX binding.', 503, { assignmentId: assignment.id });
	// Completion projects immutable agent output into governance. Under concurrent
	// report collection, repository reads can exceed the interactive proxy timeout.
	const client = connection.client;
	const workday = await store.getCapacityWorkdayRun(assignment.teamId, assignmentWorkdayRunId(assignment));
	const registered: unknown[] = [];
	for (const reference of executionPlanReferences) {
		const commitSha = text(reference.commitSha,manifest.commit?.sha);
		if (!commitSha) throw new CapacityGovernanceError('assignment_execution_plan_commit_missing', 'Execution-plan output requires an immutable TreeDX commit.', 409, { assignmentId: assignment.id, contentPath: reference.contentPath });
		const response = await client.readRepositoryFiles({ ref: commitSha, paths: [reference.contentPath], encoding: 'utf8', parseFrontmatter: true });
		const file = repositoryFile(response), frontmatter = record(file.frontmatter);
		assertPlanningArtifactContent('execution_plan',reference.contentPath,frontmatter,assignment.id);
		const assignedInput = assignmentActivityInput(assignment), proposalRef = record(assignedInput.proposalRef);
		if (text(frontmatter.proposalId) !== text(proposalRef.id) || Number(frontmatter.proposalRevision) !== Number(proposalRef.revision)
			|| text(frontmatter.proposalDigest) !== text(proposalRef.digest) || text(reference.subjectId) !== text(proposalRef.id)) {
			throw new CapacityGovernanceError('assignment_execution_plan_scope_invalid', 'Execution plan does not bind the exact assigned proposal revision.', 409, { assignmentId: assignment.id, contentPath: reference.contentPath });
		}
		registered.push({ model: 'execution_plan', id: text(frontmatter.id), revision: Number(frontmatter.revision), contentPath: reference.contentPath, commitSha });
	}
	for (const reference of proposalReferences) {
		const commitSha = text(reference.commitSha,manifest.commit?.sha);
		if (!commitSha) throw new CapacityGovernanceError('assignment_proposal_commit_missing', 'Proposal output requires an immutable TreeDX commit.', 409, { assignmentId: assignment.id, contentPath: reference.contentPath });
		const response = await client.readRepositoryFiles({ ref: commitSha, paths: [reference.contentPath], encoding: 'utf8', parseFrontmatter: true });
		const file = repositoryFile(response);
		const frontmatter = record(file.frontmatter);
		assertPlanningArtifactContent('proposal',reference.contentPath,frontmatter,assignment.id);
		const body = text(file.body) || text(file.content);
		const proposalSlug = slug(text(frontmatter.slug) || reference.contentPath);
		const assignedProposalId = text(record(assignmentActivityInput(assignment).proposalRef).id);
		const proposalId = text(reference.subjectId, assignedProposalId) || `proposal:${assignment.projectId}:${proposalSlug}`;
		if (assignedProposalId && proposalId !== assignedProposalId) throw new CapacityGovernanceError(
			'assignment_proposal_scope_invalid', 'Proposal output does not identify the exact assigned proposal.', 409,
			{ assignmentId: assignment.id, expectedProposalId: assignedProposalId, proposalId },
		);
		const digest = createHash('sha256').update(text(file.content) || JSON.stringify({ frontmatter,body })).digest('hex');
		const objectives = strings(frontmatter.relatedObjectives ?? frontmatter.related_objectives);
		const proposalTypes = strings(frontmatter.proposalTypes ?? frontmatter.proposal_types ?? [frontmatter.proposalType ?? frontmatter.proposal_type]);
		const evidenceRefs = strings(frontmatter.evidenceRefs ?? frontmatter.evidence_refs);
		const decisionDependencies = Array.isArray(frontmatter.decisionDependencies ?? frontmatter.decision_dependencies)
			? frontmatter.decisionDependencies ?? frontmatter.decision_dependencies : [];
		const plan = record(frontmatter.plan);
		const contentProvenance = { repositoryId: connection.repositoryId, contentPath: reference.contentPath, commitSha, digest };
		const current = await store.getGovernanceProposal(proposalId);
		const proposalVersion = current ? Number(current.activeVersion ?? 0) + 1 : 1;
		const participation = proposalParticipation(workday, assignment.projectId, proposalTypes);
		const requiredParticipantIds = participation.participantIds;
		const readiness = evaluateGovernanceProposalReadiness({ title: text(frontmatter.title), summary: text(frontmatter.summary,frontmatter.description), body, relatedObjectives: objectives, proposalTypes, evidenceRefs, plan, contentProvenance });
		if (!readiness.contentReady) throw new CapacityGovernanceError('assignment_proposal_plan_incomplete', 'Agent proposal output does not satisfy the governance planning contract.', 409, { assignmentId: assignment.id, contentPath: reference.contentPath, missingRequirements: readiness.missingContent });
		const signature = JSON.stringify({ objectives: [...objectives].sort(), scope: strings(plan.scope).sort() });
		const related = await store.all(`SELECT * FROM governance_proposals WHERE project_id = ? AND status NOT IN ('withdrawn','superseded','rejected','accepted') ORDER BY created_at ASC LIMIT 500`, [assignment.projectId]);
		const duplicate = related.find((row) => {
			const metadata = record(row.metadata_json);
			return text(record(metadata.contentProvenance).digest) === digest
				&& JSON.stringify({ objectives: strings(metadata.relatedObjectives).sort(), scope: strings(record(metadata.plan).scope).sort() }) === signature;
		});
		if (duplicate) { registered.push(duplicate); continue; }
		const existing = current;
		if (existing) {
			if (record(existing.metadata).contentProvenance && text(record(record(existing.metadata).contentProvenance).digest) === digest) { registered.push(existing); continue; }
			registered.push(await persistAssignmentProposalRevision({
				store,assignment,existing,proposalId,digest,contentProvenance,
				proposal: {
					title: text(frontmatter.title),summary: text(frontmatter.summary,frontmatter.description),body,
					proposalType: proposalTypes[0],proposalTypes,relatedObjectives: objectives,evidenceRefs,
					decisionDependencies,plan,changeReason: text(frontmatter.changeReason,frontmatter.revisionSummary),
					metadata: { requiredParticipantIds,requiredReviewerClasses: participation.requiredReviewerClasses,participationSnapshot: participation.participationSnapshot,
						modeRunId: manifest.modeRunId,scene: record(workday?.metadata).scene ?? null,run: record(workday?.metadata).run ?? null },
				},
			}));
			continue;
		}
		registered.push(await store.createGovernanceProposal(null, {
			id: proposalId, teamId: assignment.teamId, projectId: assignment.projectId, scope: 'project', status: 'submitted',
			title: text(frontmatter.title), summary: text(frontmatter.summary,frontmatter.description), body,
			proposalType: proposalTypes[0], proposalTypes, contentProposalSlug: proposalSlug,
			relatedObjectives: objectives, evidenceRefs, decisionDependencies, plan, contentProvenance, createdByType: 'agent', createdById: assignment.agentId,
			metadata: { authorAgentId: assignment.agentId, assignmentId: assignment.id, workdayId: assignment.workDayId,
				modeRunId: manifest.modeRunId, requiredParticipantIds, requiredReviewerClasses: participation.requiredReviewerClasses, participationSnapshot: participation.participationSnapshot,
				scene: record(workday?.metadata).scene ?? null, run: record(workday?.metadata).run ?? null },
		}));
	}
	for (const reference of feedbackReferences) {
		const commitSha = text(reference.commitSha,manifest.commit?.sha);
		if (!commitSha) throw new CapacityGovernanceError('assignment_proposal_feedback_scope_invalid', 'Proposal feedback requires immutable TreeDX content.', 409, { assignmentId: assignment.id });
		const proposal = await resolveProposalFeedbackSubject(store, assignment, text(reference.subjectId));
		const proposalId = String(proposal.id);
		const proposalVersion = reviewedProposalVersion(assignment, proposal);
		const response = await client.readRepositoryFiles({ ref: commitSha, paths: [reference.contentPath], encoding: 'utf8', parseFrontmatter: true });
		const file = repositoryFile(response);
		const frontmatter = record(file.frontmatter);
		assertPlanningArtifactContent(reference.model,reference.contentPath,frontmatter,assignment.id);
		const body = text(file.body,file.content);
		const kind = reference.model === 'question' ? 'question' : text(frontmatter.feedbackKind,frontmatter.feedback_kind).toLowerCase();
		if (!['support','concern','question','response'].includes(kind)) throw new CapacityGovernanceError('assignment_proposal_feedback_kind_invalid', 'Proposal feedback must declare support, concern, question, or response.', 409, { assignmentId: assignment.id, contentPath: reference.contentPath });
		const feedbackSeverity = text(frontmatter.feedbackSeverity,frontmatter.feedback_severity) || (['concern','question'].includes(kind) ? 'blocking' : 'advisory');
		const feedbackStatus = text(frontmatter.feedbackStatus,frontmatter.feedback_status) || (kind === 'response' ? 'resolved' : 'open');
		const resolves = strings(frontmatter.resolves);
		if (kind === 'response' && !resolves.length) throw new CapacityGovernanceError('assignment_proposal_feedback_resolution_missing', 'Proposal feedback responses must identify the exact feedback event they resolve.', 409, { assignmentId: assignment.id, contentPath: reference.contentPath });
		const eventId = `proposal-feedback:${assignment.id}:${reference.receiptId}`;
		const existingEvent = await store.first(`SELECT id FROM governance_events WHERE id = ? LIMIT 1`, [eventId]);
		if (!existingEvent) await store.recordGovernanceEvent({
			id: eventId, eventType: 'proposal.discussion', actorType: 'agent', actorId: assignment.agentId,
			teamId: assignment.teamId, projectId: assignment.projectId, proposalId,
			message: text(frontmatter.summary,frontmatter.description,body.slice(0,500)),
			evidence: { kind, feedbackSeverity, feedbackStatus, producerClass: assignment.projectAgentClassId,
				...(resolves[0] ? { resolvesEventId: resolves[0] } : {}), proposalVersion, contentPath: reference.contentPath, commitSha,
				digest: createHash('sha256').update(text(file.content) || JSON.stringify({ frontmatter,body })).digest('hex'),
				assignmentId: assignment.id, workdayId: assignment.workDayId, modeRunId: manifest.modeRunId },
		});
	}
	return registered;
}

export async function projectCompletedPlanningOutputs(
	store: AssignmentPlanningOutputStore,
	assignment: DurableProviderAssignment,
	input: JsonRecord,
) {
	if (assignment.mode !== 'planning') return null;
	const output = record(input.output);
	const manifest = planningManifest(assignment,input);
	const registered = await registerProposalArtifacts(store,assignment,manifest);
	const envelopeInput = record(record(assignment.decisionInput).input);
	const planningInputRequestId = text(envelopeInput.planningInputRequestId, assignmentActivityInput(assignment).planningInputRequestId);
	if (planningInputRequestId) await store.run(
		`UPDATE agent_invocation_requests SET status = 'completed', response_json = ?, completed_at = COALESCE(completed_at, ?)
		 WHERE id = ? AND team_id = ? AND project_id = ? AND execution_kind = 'workday' AND status IN ('queued','completed')`,
		[JSON.stringify({ assignmentId: assignment.id, summary: output.summary ?? null }), new Date().toISOString(), planningInputRequestId, assignment.teamId, assignment.projectId],
	);
	return registered.length ? registered : null;
}
