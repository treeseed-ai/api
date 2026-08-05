import { evaluateGovernanceProposalReadiness } from '@treeseed/sdk';
import type { AgentArtifactManifest,StructuredAgentEstimateRecord } from '@treeseed/sdk/agent-capacity';
import { validateAgentArtifactManifest } from '@treeseed/sdk/agent-capacity';
import { TreeDxClient } from '@treeseed/sdk/treedx/client';
import { createHash } from 'node:crypto';
import { CapacityGovernanceError,type CapacityGovernanceDatabase } from '../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import { assignmentArtifactManifest } from '../context/assignment-deliverable-service.ts';
import { resolveWorkdayTreeDxConnection,type WorkdayTreeDxConnectionStore } from '../../workdays/treedx/workday-treedx-connection.ts';

type JsonRecord = Record<string, unknown>;

export interface AssignmentPlanningOutputStore extends CapacityGovernanceDatabase,WorkdayTreeDxConnectionStore {
	getStructuredAgentEstimate(id: string): Promise<StructuredAgentEstimateRecord | null>;
	createStructuredAgentEstimate(decisionId: string, input: JsonRecord): Promise<StructuredAgentEstimateRecord | null>;
	getGovernanceProposal(id: string): Promise<any | null>;
	createGovernanceProposal(principal: unknown, input: JsonRecord): Promise<any | null>;
	getCapacityWorkdayRun(teamId: string, runId: string): Promise<any | null>;
	recordGovernanceEvent(input: JsonRecord): Promise<any | null>;
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

function proposalParticipation(workday: unknown, projectId: string, proposalTypes: string[]) {
	const snapshot = record(record(record(workday).parameters).planningGraphByProjectId)[projectId];
	const agents = Array.isArray(record(snapshot).agents) ? record(snapshot).agents as unknown[] : [];
	const contracts = record(record(snapshot).proposalTypeContracts);
	const missingTypes = proposalTypes.filter((id) => !contracts[id]);
	if (missingTypes.length) throw new CapacityGovernanceError('assignment_proposal_type_not_frozen', 'Agent proposal output contains a type outside the immutable workday contracts.', 409, { projectId, proposalTypes: missingTypes });
	const requiredClasses = new Set(proposalTypes.flatMap((id) => strings(record(contracts[id]).requiredReviewerClasses)));
	const subscriptionParticipants = agents.map(record).filter((agent) => {
		const subscriptions = Array.isArray(record(agent.signalPolicy).subscribesTo) ? record(agent.signalPolicy).subscribesTo as unknown[] : [];
		return subscriptions.map(record).some((subscription) => {
			if (text(subscription.contract) !== 'proposal-ready') return false;
			const accepted = strings(record(subscription.filters).proposalTypes);
			return !accepted.length || accepted.some((type) => proposalTypes.includes(type));
		});
	}).map((agent) => text(agent.slug)).filter(Boolean);
	const reviewerParticipants = agents.map(record).filter((agent) => requiredClasses.has(text(agent.projectAgentClassSlug)) && ['estimating','reviewing'].includes(text(agent.activityType))).map((agent) => text(agent.slug)).filter(Boolean);
	const represented = new Set(agents.map(record).filter((agent) => reviewerParticipants.includes(text(agent.slug))).map((agent) => text(agent.projectAgentClassSlug)));
	const missingReviewerClasses = [...requiredClasses].filter((id) => !represented.has(id));
	if (missingReviewerClasses.length) throw new CapacityGovernanceError('assignment_proposal_reviewer_unavailable', 'The workday graph cannot satisfy the proposal type reviewer contract.', 409, { projectId, proposalTypes, missingReviewerClasses });
	return { participantIds: [...new Set([...subscriptionParticipants,...reviewerParticipants])].sort(), requiredReviewerClasses: [...requiredClasses].sort() };
}

function repositoryFile(response: { files?: unknown[]; results?: unknown[]; file?: unknown }): JsonRecord {
	return record(response.files?.[0] ?? response.results?.[0] ?? response.file);
}

function planningManifest(assignment: DurableProviderAssignment,input: JsonRecord): AgentArtifactManifest | null {
	const manifest = assignmentArtifactManifest(input);
	if (!manifest) return null;
	const validation = validateAgentArtifactManifest(manifest);
	if (!validation.ok) throw new CapacityGovernanceError('assignment_artifact_manifest_invalid', validation.reason ?? 'Planning artifact manifest is invalid.', 409, { assignmentId: assignment.id });
	if (manifest.assignmentId !== assignment.id || manifest.projectId !== assignment.projectId || manifest.teamId !== assignment.teamId
		|| manifest.mode !== 'planning' || manifest.agentClassId !== assignment.projectAgentClassId
		|| (assignment.agentId && manifest.agentId !== assignment.agentId)) {
		throw new CapacityGovernanceError('assignment_artifact_manifest_scope_invalid', 'Planning artifact manifest scope does not match the completing assignment.', 409, { assignmentId: assignment.id });
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
	if (!proposalReferences.length && !feedbackReferences.length) return [];
	if (!assignment.workDayId) throw new CapacityGovernanceError('assignment_proposal_workday_missing', 'Proposal output requires durable workday provenance.', 409, { assignmentId: assignment.id });
	const connection = await resolveWorkdayTreeDxConnection(store, {
		projectId: assignment.projectId, runId: assignment.workDayId, capabilities: ['repos:read','files:read'],
	});
	if (!connection) throw new CapacityGovernanceError('assignment_proposal_treedx_unavailable', 'Proposal output could not be read through the project TreeDX binding.', 503, { assignmentId: assignment.id });
	// Completion projects immutable agent output into governance. Under concurrent
	// report collection, repository reads can exceed the interactive proxy timeout.
	const client = new TreeDxClient({ ...connection, repoId: connection.repositoryId, timeoutMs: 60_000, fetch: connection.fetchImpl });
	const workday = await store.getCapacityWorkdayRun(assignment.teamId, assignment.workDayId);
	const registered: unknown[] = [];
	for (const reference of proposalReferences) {
		const commitSha = text(reference.commitSha,manifest.commit?.sha);
		if (!commitSha) throw new CapacityGovernanceError('assignment_proposal_commit_missing', 'Proposal output requires an immutable TreeDX commit.', 409, { assignmentId: assignment.id, contentPath: reference.contentPath });
		const response = await client.readRepositoryFiles({ ref: commitSha, paths: [reference.contentPath], encoding: 'utf8', parseFrontmatter: true });
		const file = repositoryFile(response);
		const frontmatter = record(file.frontmatter);
		const body = text(file.body) || text(file.content);
		const proposalSlug = slug(text(frontmatter.slug) || reference.contentPath);
		const proposalId = `proposal:${assignment.projectId}:${proposalSlug}`;
		const digest = createHash('sha256').update(text(file.content) || JSON.stringify({ frontmatter,body })).digest('hex');
		const objectives = strings(frontmatter.relatedObjectives ?? frontmatter.related_objectives);
		const proposalTypes = strings(frontmatter.proposalTypes ?? frontmatter.proposal_types ?? [frontmatter.proposalType ?? frontmatter.proposal_type]);
		const evidenceRefs = strings(frontmatter.evidenceRefs ?? frontmatter.evidence_refs);
		const plan = record(frontmatter.plan);
		const contentProvenance = { repositoryId: connection.repositoryId, contentPath: reference.contentPath, commitSha, digest };
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
		const existing = await store.getGovernanceProposal(proposalId);
		if (existing) {
			if (record(existing.metadata).contentProvenance && text(record(record(existing.metadata).contentProvenance).digest) === digest) { registered.push(existing); continue; }
			throw new CapacityGovernanceError('assignment_proposal_registration_conflict', 'A governance proposal already owns this project proposal identity with different content.', 409, { assignmentId: assignment.id, proposalId });
		}
		registered.push(await store.createGovernanceProposal(null, {
			id: proposalId, teamId: assignment.teamId, projectId: assignment.projectId, scope: 'project', status: 'submitted',
			title: text(frontmatter.title), summary: text(frontmatter.summary,frontmatter.description), body,
			proposalType: proposalTypes[0], proposalTypes, contentProposalSlug: proposalSlug,
			relatedObjectives: objectives, evidenceRefs, plan, contentProvenance, createdByType: 'agent', createdById: assignment.agentId,
			metadata: { authorAgentId: assignment.agentId, assignmentId: assignment.id, workdayId: assignment.workDayId,
				modeRunId: manifest.modeRunId, requiredParticipantIds, requiredReviewerClasses: participation.requiredReviewerClasses, scene: record(workday?.metadata).scene ?? null, run: record(workday?.metadata).run ?? null },
		}));
	}
	for (const reference of feedbackReferences) {
		const commitSha = text(reference.commitSha,manifest.commit?.sha);
		const subjectSlug = slug(text(reference.subjectId));
		const proposalId = `proposal:${assignment.projectId}:${subjectSlug}`;
		if (!commitSha || !subjectSlug || !await store.getGovernanceProposal(proposalId)) throw new CapacityGovernanceError('assignment_proposal_feedback_scope_invalid', 'Proposal feedback requires an existing proposal and immutable TreeDX content.', 409, { assignmentId: assignment.id, proposalId });
		const response = await client.readRepositoryFiles({ ref: commitSha, paths: [reference.contentPath], encoding: 'utf8', parseFrontmatter: true });
		const file = repositoryFile(response);
		const frontmatter = record(file.frontmatter);
		const body = text(file.body,file.content);
		const kind = reference.model === 'question' ? 'question' : text(frontmatter.feedbackKind,frontmatter.feedback_kind).toLowerCase();
		if (!['support','concern','question','response'].includes(kind)) throw new CapacityGovernanceError('assignment_proposal_feedback_kind_invalid', 'Proposal feedback must declare support, concern, question, or response.', 409, { assignmentId: assignment.id, contentPath: reference.contentPath });
		const eventId = `proposal-feedback:${assignment.id}:${reference.receiptId}`;
		const existingEvent = await store.first(`SELECT id FROM governance_events WHERE id = ? LIMIT 1`, [eventId]);
		if (!existingEvent) await store.recordGovernanceEvent({
			id: eventId, eventType: 'proposal.discussion', actorType: 'agent', actorId: assignment.agentId,
			teamId: assignment.teamId, projectId: assignment.projectId, proposalId,
			message: text(frontmatter.summary,frontmatter.description,body.slice(0,500)),
			evidence: { kind, contentPath: reference.contentPath, commitSha,
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
	await registerProposalArtifacts(store,assignment,manifest);
	const planningInputRequestId = text(record(record(assignment.decisionInput).input).planningInputRequestId);
	if (planningInputRequestId) await store.run(
		`UPDATE planning_input_requests SET status = 'complete', response_json = ?, completed_at = COALESCE(completed_at, ?)
		 WHERE id = ? AND team_id = ? AND project_id = ? AND status IN ('requested','complete')`,
		[JSON.stringify({ assignmentId: assignment.id, summary: output.summary ?? null }), new Date().toISOString(), planningInputRequestId, assignment.teamId, assignment.projectId],
	);
	const estimate = record(record(output.metadata).structuredEstimate);
	if (!Object.keys(estimate).length) return null;
	const id = text(estimate.id);
	const decisionId = text(estimate.decisionId ?? assignment.decisionId);
	const assignedInput = record(record(assignment.decisionInput).input);
	const assignedIntent = record(assignedInput.intent);
	const proposalId = text(estimate.proposalId);
	const assignedProposalId = text(assignedInput.proposalId ?? assignedIntent.subjectId);
	if (!id || (!decisionId && !proposalId) || text(estimate.teamId) !== assignment.teamId || text(estimate.projectId) !== assignment.projectId
		|| text(estimate.agentId) !== text(assignment.agentId)) {
		throw new CapacityGovernanceError('assignment_planning_estimate_scope_invalid', 'Planning estimate output does not match its assignment scope.', 409, { assignmentId: assignment.id, estimateId: id || null });
	}
	if ((!decisionId && proposalId !== assignedProposalId) || (decisionId && assignment.decisionId && decisionId !== assignment.decisionId)) {
		throw new CapacityGovernanceError('assignment_planning_estimate_scope_invalid', 'Planning estimate output does not match its assignment scope.', 409, { assignmentId: assignment.id, estimateId: id });
	}
	// Pre-governance proposal estimates remain durable in the completed mode-run output.
	// Decision planning owns the structured-estimate repository and is only projected once a decision exists.
	if (!decisionId) return estimate;
	const existing = await store.getStructuredAgentEstimate(id);
	if (existing) {
		if (existing.decisionId === decisionId && existing.projectId === assignment.projectId && existing.metadata?.assignmentId === assignment.id) return existing;
		throw new CapacityGovernanceError('assignment_planning_estimate_conflict', 'Planning estimate id is already owned by another assignment scope.', 409, { assignmentId: assignment.id, estimateId: id });
	}
	return store.createStructuredAgentEstimate(decisionId, {
		...estimate,
		status: 'submitted',
		metadata: { ...record(estimate.metadata), assignmentId: assignment.id },
		recordMetadata: { source: 'validated_assignment_planning_output', assignmentId: assignment.id },
	});
}
