import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { decodeDurableJsonArray,decodeDurableJsonObject } from '../../durable-json.ts';
import type { DurableCapacityWorkdayRun } from '../../repositories/capacity/workdays/workday-run.ts';
import { resolveEngineeringNodeAuthority } from '../accounts/engineering-source-authority.ts';
import type { WorkdayProject } from '../capacity/workdays/policy/workday-project-policy.ts';
import { projectAgentActivityRefs } from '../projects/projects-core/project-agent-activity-refs.ts';

export interface ActingDemandSource {
	sourceType: 'capacity-plan'; sourceId: string; decisionId: string; capacityPlanId: string;
	projectAgentClassId: string; agentId: string | null; handlerId: string; activityType: string;
	priority: number; requestedSeconds: number; requiredCapabilities: string[]; agentContentPath: string | null; payload: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }

async function readyGraphNode(input: {
	database: CapacityGovernanceDatabase;
	decisionId: string;
	projectId: string;
	workGraphNodeId: string;
	projectAgentClassId: string;
	projectAgentClassSlug: string;
	handlerId: string;
}) {
	const { database, decisionId, projectId, workGraphNodeId, projectAgentClassId, projectAgentClassSlug, handlerId } = input;
	const row = await database.first(
		`SELECT id, graph_json FROM decision_assignment_graphs WHERE decision_id = ? AND project_id = ? AND active = 1 AND status = 'ready' ORDER BY version DESC LIMIT 1`,
		[decisionId, projectId],
	);
	if (!row) return null;
	const graph = decodeDurableJsonObject(row.graph_json, { owner: 'decision assignment graph', ownerId: String(row.id), column: 'graph_json' });
	const nodes = Array.isArray(graph.nodes) ? graph.nodes.map(record) : [];
	const edges = Array.isArray(graph.edges) ? graph.edges.map(record) : [];
	const node = nodes.find((candidate) => text(candidate.id) === workGraphNodeId);
	if (!node || !['pending', 'ready'].includes(String(node.status ?? ''))) return null;
	if (node.activityType !== 'acting') return null;
	if (![projectAgentClassId, projectAgentClassSlug].includes(text(node.targetAgentClass) ?? '')) return null;
	const graphHandler = text(node.handler);
	if (graphHandler && graphHandler !== handlerId) return null;
	const incoming = edges.filter((edge) => text(edge.toNodeId) === workGraphNodeId);
	for (const edge of incoming) {
		const predecessor = nodes.find((candidate) => text(candidate.id) === text(edge.fromNodeId));
		if (!predecessor || predecessor.status !== 'completed') return null;
	}
	const contractIds = Array.isArray(node.requiredDeliverableContractIds) ? node.requiredDeliverableContractIds.map(String) : [];
	for (const contractId of contractIds) {
		if (!await database.first(`SELECT id FROM deliverable_contracts WHERE id = ? AND status = 'approved' LIMIT 1`, [contractId])) return null;
	}
	const authority = await resolveEngineeringNodeAuthority({ database, graphId: String(row.id), graph, node });
	const outputRequirements = Array.isArray(node.outputRequirements) ? node.outputRequirements.map(record) : [];
	return {
		graphId: String(row.id), nodeId: workGraphNodeId,
		outputRequirements,
		...authority,
	};
}

async function classAuthorizesActing(database: CapacityGovernanceDatabase, projectId: string, classId: string, agentId: string | null, handlerId: string) {
	const row = await database.first(`SELECT slug, status, allowed_modes_json, handler_refs_json FROM project_agent_classes WHERE id = ? AND project_id = ? LIMIT 1`, [classId, projectId]);
	if (!row || row.status !== 'active') return null;
	const modes = decodeDurableJsonArray<string>(row.allowed_modes_json, { owner: 'project agent class', ownerId: classId, column: 'allowed_modes_json' });
	if (!modes.includes('acting')) return null;
	const refs = decodeDurableJsonObject(row.handler_refs_json, { owner: 'project agent class', ownerId: classId, column: 'handler_refs_json' });
	const activity = projectAgentActivityRefs(refs, 'acting').find((agent) => agent.handlerId === handlerId && (!agentId || agent.agentId === agentId));
	return activity ? { slug: text(row.slug) ?? classId, contentPath: activity.contentPath } : null;
}

export async function listActingDemandSources(
	database: CapacityGovernanceDatabase,
	run: DurableCapacityWorkdayRun,
	project: WorkdayProject,
	workdayId: string,
): Promise<ActingDemandSource[]> {
	const rows = await database.all(
		`SELECT plan.*, readiness.human_approval_state, readiness.execution_readiness, readiness.planning_inputs_status
		 FROM agent_capacity_plans plan LEFT JOIN decision_planning_statuses readiness ON readiness.decision_id = plan.decision_id
		 WHERE plan.team_id = ? AND plan.project_id = ? AND plan.status IN ('accepted','scheduled','active')
		   AND (plan.work_day_id = ? OR plan.work_day_id IS NULL)
		 ORDER BY plan.created_at DESC, plan.id DESC LIMIT 50`,
		[run.teamId, project.id, workdayId],
	);
	const sources: ActingDemandSource[] = [];
	const seenDecisions = new Set<string>();
	for (const row of rows) {
		const decisionId = text(row.decision_id);
		if (!decisionId || seenDecisions.has(decisionId)) continue;
		seenDecisions.add(decisionId);
		if (row.human_approval_state !== 'approved') continue;
		if (!['ready', 'waived'].includes(String(row.execution_readiness ?? ''))) continue;
		if (!['complete', 'waived'].includes(String(row.planning_inputs_status ?? ''))) continue;
		const workUnits = decodeDurableJsonArray(row.work_units_json, { owner: 'capacity plan', ownerId: String(row.id), column: 'work_units_json' });
		for (const [index, value] of workUnits.entries()) {
			const unit = record(value);
			if (unit.mode && unit.mode !== 'acting') continue;
			if (Array.isArray(unit.blockers) && unit.blockers.length > 0) continue;
			const projectAgentClassId = text(unit.projectAgentClassId);
			const handlerId = text(unit.handlerId ?? record(unit.decisionInput).handlerId);
			const requestedSeconds = Number(unit.highSeconds ?? unit.expectedSeconds ?? 0);
			if (!projectAgentClassId || !handlerId || !Number.isInteger(requestedSeconds) || requestedSeconds <= 0) throw new CapacityGovernanceError(
				'capacity_workday_acting_demand_invalid', `Capacity plan ${String(row.id)} has an invalid acting work unit.`, 500,
				{ capacityPlanId: String(row.id), workUnitIndex: index },
			);
			const sourceId = text(unit.id) ?? `${String(row.id)}:${index}`;
			const estimateId = text(unit.estimateId ?? record(unit.metadata).estimateId ?? record(unit.decisionInput).estimateId ?? record(record(unit.decisionInput).metadata).estimateId);
			const acceptedEstimate = estimateId ? await database.first(`SELECT id FROM structured_agent_estimates
				WHERE id = ? AND team_id = ? AND project_id = ? AND decision_id = ? AND status = 'accepted' LIMIT 1`,
				[estimateId, run.teamId, project.id, decisionId]) : null;
			if (!acceptedEstimate) continue;
			const workGraphNodeId = text(unit.workGraphNodeId ?? record(unit.decisionInput).workGraphNodeId);
			const agentId = text(unit.agentId ?? record(unit.decisionInput).agentId);
			if (!workGraphNodeId) continue;
			const authorizedClass = await classAuthorizesActing(database, project.id, projectAgentClassId, agentId, handlerId);
			if (!authorizedClass) continue;
			const graphNode = await readyGraphNode({
				database, decisionId, projectId: project.id, workGraphNodeId, projectAgentClassId,
				projectAgentClassSlug: authorizedClass.slug, handlerId,
			});
			if (!graphNode) continue;
			const requiredCapabilities = Array.isArray(unit.requiredCapabilities) ? unit.requiredCapabilities.map(String).filter(Boolean) : [];
			const capacityPlanId = String(row.id);
			const capacityPlanStatus = String(row.status);
			const decisionInput = decodeDurableJsonObject(JSON.stringify(record(unit.decisionInput)), { owner: 'capacity plan work unit', ownerId: sourceId, column: 'decisionInput' });
			const governedInput = {
				...record(decisionInput.input),
				workGraphId: graphNode.graphId,
				workGraphNodeId: graphNode.nodeId,
				...(text(graphNode.outputRequirements.find((requirement) => requirement.required !== false)?.outputType
					?? graphNode.outputRequirements[0]?.outputType) ? {
					artifactKind: text(graphNode.outputRequirements.find((requirement) => requirement.required !== false)?.outputType
						?? graphNode.outputRequirements[0]?.outputType),
				} : {}),
				...(graphNode.exactBaseRef ? {
					exactBaseRef: graphNode.exactBaseRef,
					governedPredecessorEvidence: graphNode.predecessorEvidence,
					...(graphNode.reviewPolicy ? { governedReviewPolicy: graphNode.reviewPolicy } : {}),
				} : {}),
			};
			sources.push({
				sourceType: 'capacity-plan', sourceId, decisionId, capacityPlanId, projectAgentClassId,
				agentId, handlerId,
				activityType: text(unit.activityType) ?? 'acting', priority: Number(record(unit.metadata).priority ?? 100),
				requestedSeconds, requiredCapabilities, agentContentPath: authorizedClass.contentPath,
				payload: {
					agentContentPath: authorizedClass.contentPath,
					decisionInput: { ...decisionInput, input: governedInput, metadata: { ...record(decisionInput.metadata), capacityPlanId, capacityPlanStatus, synthesizedFrom: 'capacity_plan', readiness: { executionReadiness: row.execution_readiness, planningInputsStatus: row.planning_inputs_status } } },
					capacityEnvelope: { ...record(unit.capacityEnvelope), metadata: { ...record(record(unit.capacityEnvelope).metadata), capacityPlanId, capacityPlanStatus, synthesizedFrom: 'capacity_plan' } }, requiredCapabilities,
					executionReadiness: row.execution_readiness, planningInputsStatus: row.planning_inputs_status,
					allowedOutputs: {
						types: ['content_artifact_refs'],
						artifactKinds: graphNode.outputRequirements.map((requirement) => text(requirement.outputType)).filter(Boolean),
					},
					decisionExecutionInputId: unit.decisionExecutionInputId ?? null, estimateId, ...graphNode,
				},
			});
		}
	}
	return sources;
}
