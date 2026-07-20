import type { CapacityGovernanceDatabase } from '../database.ts';
import { decodeDurableJsonObject } from '../durable-json.ts';
import type { DurableCapacityWorkdayRun } from '../repositories/workday-run.ts';
import type { CapacityWorkdayAgent } from './workday-agent-policy.ts';
import { listCapacityWorkdayContentArtifactRefs, type CapacityWorkdayResolvedIntent } from './workday-assignment-context-service.ts';
import type { WorkdayProject } from './workday-project-policy.ts';
import { listTreeDxPlanningDemandSources, type TreeDxPlanningDemandSource } from './workday-content-demand-source.ts';
import type { WorkdayTreeDxConnectionStore } from './workday-treedx-connection.ts';
import { serializeResearchWorkflowRow } from '../repositories/research-workflow.ts';

export interface PlanningDemandSource {
	sourceType: 'objective' | 'question' | 'proposal' | 'decision-review' | 'knowledge-gap' | 'release-readiness'
		| 'idle-intent' | 'planning-input' | 'assignment-completion' | 'assignment-blockage' | 'workday-summary' | 'handoff'
		| 'research-workflow';
	sourceId: string;
	decisionId: string | null;
	priority: number;
	requestedCredits: number;
	payload: Record<string, unknown>;
}

function isTreeDxStore(value: CapacityGovernanceDatabase): value is CapacityGovernanceDatabase & WorkdayTreeDxConnectionStore {
	const candidate = value as Partial<WorkdayTreeDxConnectionStore>;
	return Boolean(candidate.config && typeof candidate.getProjectTreeDxLibrary === 'function');
}

function preferredContentSource(agent: CapacityWorkdayAgent, sources: TreeDxPlanningDemandSource[]) {
	const identity = `${agent.slug}:${agent.activityType}:${agent.handler}`.toLowerCase();
	const preference = identity.includes('review') ? ['proposal', 'decision-review', 'objective', 'question']
		: identity.includes('research') ? ['knowledge-gap', 'question', 'objective', 'proposal']
			: ['objective', 'question', 'knowledge-gap', 'proposal', 'decision-review'];
	for (const type of preference) {
		const source = sources.find((candidate) => candidate.sourceType === type);
		if (source) return source;
	}
	return null;
}

function researchRole(agent: CapacityWorkdayAgent) {
	const identity = `${agent.slug}:${agent.activityType}:${agent.handler}`.toLowerCase();
	if (identity.includes('technical-writer') || identity.includes('technical_writer')) return 'technical-writer';
	if (identity.includes('review')) return 'reviewer';
	if (identity.includes('report')) return 'reporter';
	if (identity.includes('research')) return 'researcher';
	return null;
}

function researchStageIntent(stage: string, intent: CapacityWorkdayResolvedIntent): CapacityWorkdayResolvedIntent {
	const artifactKind = stage === 'question-decomposition' ? 'planning_question'
		: stage === 'cited-knowledge-publication' ? 'knowledge_page'
			: stage === 'workday-report' ? 'workday_summary'
				: 'planning_note';
	return { ...intent, artifactKind, subjectModel: 'question', subjectId: intent.subjectId ?? 'what-should-this-research-map-first' };
}

async function researchWorkflowSource(
	database: CapacityGovernanceDatabase,
	project: WorkdayProject,
	agent: CapacityWorkdayAgent,
	intent: CapacityWorkdayResolvedIntent,
): Promise<PlanningDemandSource | null> {
	const role = researchRole(agent);
	if (!role) return null;
	const rows = await database.all(
		`SELECT * FROM research_workflows WHERE project_id = ? AND status IN ('ready','running') ORDER BY created_at ASC, id ASC LIMIT 25`,
		[project.id],
	);
	for (const row of rows) {
		const workflow = serializeResearchWorkflowRow(row);
		const node = workflow?.nodes.find((candidate) => candidate.status === 'ready');
		if (!workflow || !node || node.role !== role) continue;
		return {
			sourceType: 'research-workflow', sourceId: `${workflow.id}:${node.stage}`, decisionId: null, priority: 100,
			requestedCredits: 1,
			payload: {
				intent: researchStageIntent(node.stage, intent), planningSource: 'research-workflow', researchWorkflowId: workflow.id, researchWorkflowStateVersion: workflow.stateVersion,
				researchStage: node.stage, objectiveRef: workflow.objectiveRef, questionRef: workflow.questionRef,
				minimumIndependentSources: workflow.minimumIndependentSources, citations: workflow.citations, claims: workflow.claims,
				reviewerRejectedUnsupportedClaims: workflow.reviewerRejectedUnsupportedClaims,
				reviewerApprovedRevision: workflow.reviewerApprovedRevision, revisionCount: workflow.revisionCount,
			},
		};
	}
	return null;
}

async function operationalSource(
	database: CapacityGovernanceDatabase,
	run: DurableCapacityWorkdayRun,
	project: WorkdayProject,
	agent: CapacityWorkdayAgent,
): Promise<PlanningDemandSource | null> {
	const identity = `${agent.slug}:${agent.activityType}:${agent.handler}`.toLowerCase();
	const failed = await database.first(
		`SELECT assignment.id, assignment.lifecycle_code, assignment.lifecycle_reason FROM capacity_provider_assignments assignment
		 JOIN capacity_workday_demands demand ON demand.assignment_id = assignment.id
		 WHERE demand.workday_run_id = ? AND demand.project_id = ? AND assignment.status = 'failed'
		 ORDER BY assignment.updated_at ASC, assignment.id ASC LIMIT 1`, [run.id, project.id],
	);
	if (failed && (identity.includes('review') || identity.includes('architect') || identity.includes('engineer'))) return {
		sourceType: 'assignment-blockage', sourceId: `assignment:${String(failed.id)}`, decisionId: null, priority: 95,
		requestedCredits: 1, payload: { planningSource: 'assignment-blockage', assignmentId: failed.id,
			lifecycleCode: failed.lifecycle_code ?? null, lifecycleReason: failed.lifecycle_reason ?? null },
	};
	const completed = await database.first(
		`SELECT assignment.id FROM capacity_provider_assignments assignment JOIN capacity_workday_demands demand ON demand.assignment_id = assignment.id
		 WHERE demand.workday_run_id = ? AND demand.project_id = ? AND assignment.status = 'completed'
		 ORDER BY assignment.completed_at ASC, assignment.id ASC LIMIT 1`, [run.id, project.id],
	);
	if (completed && identity.includes('review')) return {
		sourceType: 'assignment-completion', sourceId: `assignment:${String(completed.id)}`, decisionId: null, priority: 90,
		requestedCredits: 1, payload: { planningSource: 'assignment-completion', assignmentId: completed.id },
	};
	if (completed && identity.includes('release')) return {
		sourceType: 'release-readiness', sourceId: `run:${run.id}:project:${project.id}`, decisionId: null, priority: 85,
		requestedCredits: 1, payload: { planningSource: 'release-readiness', completedAssignmentId: completed.id },
	};
	if (completed && identity.includes('report')) return {
		...(await listCapacityWorkdayContentArtifactRefs(database, run, project.id)).some((artifact) =>
			artifact.artifactKind === 'workday_summary' || artifact.artifactKind === 'workday-summary')
			? { sourceType: 'handoff' as const, sourceId: `run:${run.id}:project:${project.id}:handoff`, priority: 35,
				payload: { planningSource: 'handoff', completedAssignmentId: completed.id } }
			: { sourceType: 'workday-summary' as const, sourceId: `run:${run.id}:project:${project.id}`, priority: 40,
				payload: { planningSource: 'workday-summary', completedAssignmentId: completed.id } },
		decisionId: null, requestedCredits: 1,
	};
	return null;
}

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function positive(value: unknown, fallback: number): number {
	const candidate = Number(value ?? fallback);
	return Number.isFinite(candidate) && candidate > 0 ? candidate : fallback;
}

export async function resolvePlanningDemandSource(
	database: CapacityGovernanceDatabase,
	run: DurableCapacityWorkdayRun,
	project: WorkdayProject,
	agent: CapacityWorkdayAgent,
	intent: CapacityWorkdayResolvedIntent,
): Promise<PlanningDemandSource> {
	const research = await researchWorkflowSource(database, project, agent, intent);
	if (research) return research;
	const rows = await database.all(
		`SELECT * FROM planning_input_requests
		 WHERE team_id = ? AND project_id = ? AND status = 'requested'
		   AND (project_agent_class_id = ? OR project_agent_class_id IS NULL)
		 ORDER BY requested_at ASC, id ASC LIMIT 25`,
		[run.teamId, project.id, agent.projectAgentClassId],
	);
	for (const row of rows) {
		const metadata = decodeDurableJsonObject(row.metadata_json, {
			owner: 'planning input request', ownerId: String(row.id ?? ''), column: 'metadata_json',
		});
		const requestedAgent = text(metadata.agentId ?? metadata.agentSlug);
		if (requestedAgent && requestedAgent !== agent.slug) continue;
		return {
			sourceType: 'planning-input', sourceId: String(row.id), decisionId: text(row.decision_id),
			priority: Number.isFinite(Number(metadata.priority)) ? Number(metadata.priority) : 50,
			requestedCredits: positive(metadata.reservedCredits, 1),
			payload: {
				intent, prompt: text(row.prompt), planningInputRequestId: String(row.id), scopeHash: row.scope_hash ?? null,
				planningSource: metadata.planningSource ?? 'planning-input',
			},
		};
	}
	const operational = await operationalSource(database, run, project, agent);
	if (operational) return { ...operational, payload: { intent, ...operational.payload } };
	if (isTreeDxStore(database)) {
		const content = preferredContentSource(agent, await listTreeDxPlanningDemandSources(database, run, project));
		if (content) return {
			sourceType: content.sourceType, sourceId: content.sourceId, decisionId: null, priority: content.priority,
			requestedCredits: 1, payload: { intent, ...content.payload },
		};
	}
	return {
		sourceType: 'idle-intent', sourceId: `${run.id}:${project.id}:${agent.slug}`,
		decisionId: null, priority: agent.planningPriority ?? 0, requestedCredits: 1,
		payload: { intent, planningSource: 'configured-idle-intent' },
	};
}
