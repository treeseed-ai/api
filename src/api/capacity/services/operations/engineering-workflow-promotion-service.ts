import { createHash } from 'node:crypto';
import {
	validateEngineeringWorkflowPromotionConfig,
	type AgentCapacityPlanRecord,
	type DurableAgentCapacityPlanStatus,
	type DecisionAssignmentGraphRecord,
	type DecisionExecutionInputRecord,
	type DecisionExecutionInputStatus,
	type DecisionPlanningStatus,
	type EngineeringWorkflowPromotionConfigV1,
	type ProjectAgentClass,
	type StructuredAgentEstimate,
	type StructuredAgentEstimateStatus,
} from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { ProjectAgentClassRepository } from '../../repositories/projects/agents/project-agent-class.ts';
import type { DurableCapacityWorkdayRun } from '../../repositories/capacity/workdays/workday-run.ts';
import { projectAgentActivityRefs } from '../projects/projects-core/project-agent-activity-refs.ts';
import type { CreateDecisionExecutionInputInput } from '../support/planning-state-service.ts';
import type { CreateAgentCapacityPlanInput } from '../capacity/planning/agent-capacity-plan-service.ts';
import type { AgentCapacityPlanTransitionInput } from '../../repositories/capacity/planning/agent-capacity-plan.ts';

type JsonRecord = Record<string, unknown>;

export interface EngineeringWorkflowPromotionStore extends CapacityGovernanceDatabase {
	getDecisionPlanningStatus(decisionId: string): Promise<DecisionPlanningStatus | null>;
	listStructuredAgentEstimatesForDecision(decisionId: string, filters?: { status?: StructuredAgentEstimateStatus }): Promise<StructuredAgentEstimate[]>;
	listDecisionAssignmentGraphsForDecision(decisionId: string, filters?: JsonRecord): Promise<DecisionAssignmentGraphRecord[]>;
	createDecisionAssignmentGraph(decisionId: string, input: JsonRecord): Promise<DecisionAssignmentGraphRecord | null>;
	activateDecisionAssignmentGraphVersion(graphId: string): Promise<DecisionAssignmentGraphRecord | null>;
	createDecisionExecutionInput(decisionId: string, input: CreateDecisionExecutionInputInput): Promise<DecisionExecutionInputRecord | null>;
	listDecisionExecutionInputs(decisionId: string, filters?: { status?: DecisionExecutionInputStatus }): Promise<DecisionExecutionInputRecord[]>;
	createAgentCapacityPlan(decisionId: string, input: CreateAgentCapacityPlanInput): Promise<AgentCapacityPlanRecord | null>;
	listAgentCapacityPlans(decisionId: string, filters?: { status?: DurableAgentCapacityPlanStatus | null }): Promise<AgentCapacityPlanRecord[]>;
	updateAgentCapacityPlanStatus(planId: string, status: DurableAgentCapacityPlanStatus, input?: AgentCapacityPlanTransitionInput): Promise<AgentCapacityPlanRecord | null>;
}

export interface EngineeringWorkflowPromotionResult {
	id: string;
	projectId: string;
	decisionId: string;
	status: 'awaiting-approval' | 'awaiting-estimate' | 'promoted';
	graphId: string | null;
	capacityPlanId: string | null;
	decisionExecutionInputIds: string[];
}

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stableHash(value: unknown) {
	return createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 32);
}

export function engineeringWorkflowPromotionConfigs(parameters: JsonRecord): EngineeringWorkflowPromotionConfigV1[] {
	if (parameters.engineeringWorkflows == null) return [];
	if (!Array.isArray(parameters.engineeringWorkflows)) {
		throw new CapacityGovernanceError('engineering_workflow_config_invalid', 'engineeringWorkflows must be an array.', 400);
	}
	const ids = new Set<string>();
	return parameters.engineeringWorkflows.map((value, index) => {
		const validation = validateEngineeringWorkflowPromotionConfig(value);
		if (!validation.ok) throw new CapacityGovernanceError(
			'engineering_workflow_config_invalid',
			`Engineering workflow configuration at index ${index} is invalid.`,
			400,
			{ index, diagnostics: validation.diagnostics },
		);
		const config = value as EngineeringWorkflowPromotionConfigV1;
		if (ids.has(config.id)) throw new CapacityGovernanceError('engineering_workflow_config_duplicate', `Engineering workflow id ${config.id} is duplicated.`, 400, { id: config.id });
		ids.add(config.id);
		return config;
	});
}

function handlerSelection(agentClass: ProjectAgentClass, graphHandler: string | null) {
	if (agentClass.status !== 'active' || !agentClass.allowedModes.includes('acting')) return null;
	const agents = projectAgentActivityRefs(agentClass.handlerRefs, 'acting');
	const matching = graphHandler ? agents.filter((agent) => agent.handlerId === graphHandler) : agents;
	if (matching.length !== 1) throw new CapacityGovernanceError(
		'engineering_workflow_agent_ambiguous',
		`Engineering workflow class ${agentClass.slug} must resolve exactly one acting agent/handler.`,
		409,
		{ projectAgentClassId: agentClass.id, graphHandler, matchCount: matching.length },
	);
	return { agentId: matching[0]!.agentId, handlerId: matching[0]!.handlerId };
}

async function resolveAgentClass(repository: ProjectAgentClassRepository, projectId: string, target: string) {
	const agentClass = await repository.getBySlug(projectId, target) ?? await repository.get(projectId, target);
	if (!agentClass) throw new CapacityGovernanceError('engineering_workflow_agent_class_missing', `Engineering workflow agent class ${target} is unavailable.`, 409, { projectId, targetAgentClass: target });
	return agentClass;
}

async function graphFor(
	store: EngineeringWorkflowPromotionStore,
	config: EngineeringWorkflowPromotionConfigV1,
	run: DurableCapacityWorkdayRun,
) {
	const graphId = `dag_${stableHash({ teamId: run.teamId, projectId: config.projectId, decisionId: config.decisionId, workflowId: config.id })}`;
	const existing = (await store.listDecisionAssignmentGraphsForDecision(config.decisionId)).find((graph) => graph.id === graphId) ?? null;
	let graph = existing;
	if (!graph) {
		try {
			graph = await store.createDecisionAssignmentGraph(config.decisionId, {
				id: graphId, projectId: config.projectId, workflowKind: 'engineering-test-first', exactBaseRef: config.exactBaseRef,
				roles: config.roles, includeResearch: config.includeResearch === true, includeArchitecture: config.includeArchitecture === true,
				credits: config.credits ?? {}, metadata: {
					...(config.metadata ?? {}), workflowPromotionId: config.id, workdayRunId: run.id, objectiveId: config.objectiveId,
					requireRevisionCycle: config.requireRevisionCycle === true,
				},
			});
		} catch (error) {
			graph = (await store.listDecisionAssignmentGraphsForDecision(config.decisionId)).find((candidate) => candidate.id === graphId) ?? null;
			if (!graph) throw error;
		}
	}
	if (!graph) throw new CapacityGovernanceError('engineering_workflow_graph_persistence_failed', 'Engineering workflow graph was not persisted.', 500, { graphId });
	if (graph.projectId !== config.projectId || graph.metadata?.workflowPromotionId !== config.id
		|| graph.metadata?.exactBaseRef !== config.exactBaseRef
		|| graph.metadata?.requireRevisionCycle !== (config.requireRevisionCycle === true)) {
		throw new CapacityGovernanceError('engineering_workflow_graph_conflict', 'Existing engineering workflow graph does not match the requested promotion.', 409, { graphId });
	}
	if (!graph.active) {
		try { graph = await store.activateDecisionAssignmentGraphVersion(graph.id); }
		catch (error) {
			const observed = (await store.listDecisionAssignmentGraphsForDecision(config.decisionId)).find((candidate) => candidate.id === graphId);
			if (!observed?.active) throw error;
			graph = observed;
		}
	}
	if (!graph?.active) throw new CapacityGovernanceError('engineering_workflow_graph_activation_failed', 'Engineering workflow graph was not activated.', 500, { graphId });
	return graph;
}

async function createNodeInputs(input: {
	store: EngineeringWorkflowPromotionStore;
	run: DurableCapacityWorkdayRun;
	config: EngineeringWorkflowPromotionConfigV1;
	graph: DecisionAssignmentGraphRecord;
	estimates: StructuredAgentEstimate[];
	workdayId: string;
	allocationSetId: string | null;
}) {
	const classes = new ProjectAgentClassRepository(input.store);
	const ids: string[] = [];
	for (const node of input.graph.nodes) {
		const agentClass = await resolveAgentClass(classes, input.config.projectId, node.targetAgentClass);
		const selected = handlerSelection(agentClass, text(node.handler));
		if (!selected?.agentId) throw new CapacityGovernanceError('engineering_workflow_agent_missing', `Engineering workflow class ${agentClass.slug} has no uniquely configured agent.`, 409, { projectAgentClassId: agentClass.id });
		const estimate = input.estimates.find((candidate) => candidate.agentClass === agentClass.id || candidate.agentClass === agentClass.slug) ?? input.estimates[0]!;
		const id = `dei_${stableHash({ graphId: input.graph.id, nodeId: node.id })}`;
		const scopeHash = `scope_${stableHash({ graphId: input.graph.id, nodeId: node.id, exactBaseRef: input.config.exactBaseRef, estimateIds: input.estimates.map((entry) => entry.id).sort() })}`;
		const dependencies = input.graph.edges.filter((edge) => edge.toNodeId === node.id).map((edge) => edge.fromNodeId).sort();
		const created = await input.store.createDecisionExecutionInput(input.config.decisionId, {
			id, projectId: input.config.projectId, projectAgentClassId: agentClass.id, mode: 'acting', status: 'accepted', scopeHash,
			humanApprovalState: 'approved', planningInputsStatus: 'complete',
			input: {
				workGraphNodeId: node.id, taskId: node.id, workDayId: input.workdayId, agentId: selected.agentId, handlerId: selected.handlerId,
				capacity: {
					teamId: input.run.teamId, projectId: input.config.projectId, workDayId: input.workdayId,
					allocationSetId: input.allocationSetId, mode: 'acting', projectAgentClassId: agentClass.id,
				},
				input: {
					objectiveId: input.config.objectiveId, decisionId: input.config.decisionId, proposalId: estimate.proposalId ?? null,
					workGraphId: input.graph.id, workGraphNodeId: node.id, exactBaseRef: input.config.exactBaseRef,
					artifactKind: node.outputRequirements.find((requirement) => requirement.required !== false)?.outputType ?? node.outputRequirements[0]?.outputType,
					estimate: { expectedCredits: node.capacity.expectedCredits, highCredits: node.capacity.maxCredits },
					requiredCapabilities: node.requiredCapabilities, dependencies, expectedOutputs: node.outputRequirements,
				},
				metadata: { workflowPromotionId: input.config.id, workdayRunId: input.run.id, graphId: input.graph.id, graphNodeId: node.id, estimateId: estimate.id },
			},
			metadata: { workflowPromotionId: input.config.id, graphId: input.graph.id, graphNodeId: node.id },
		});
		if (!created || created.id !== id || created.status !== 'accepted') throw new CapacityGovernanceError('engineering_workflow_execution_input_failed', 'Engineering workflow execution input was not durably accepted.', 500, { id, graphNodeId: node.id });
		ids.push(id);
	}
	return ids.sort();
}

export async function promoteEngineeringWorkflows(
	store: EngineeringWorkflowPromotionStore,
	run: DurableCapacityWorkdayRun,
): Promise<EngineeringWorkflowPromotionResult[]> {
	const configs = engineeringWorkflowPromotionConfigs(run.parameters);
	const results: EngineeringWorkflowPromotionResult[] = [];
	for (const config of configs) {
		const base = { id: config.id, projectId: config.projectId, decisionId: config.decisionId };
		const planning = await store.getDecisionPlanningStatus(config.decisionId);
		if (!planning || planning.projectId !== config.projectId || planning.humanApprovalState !== 'approved') {
			results.push({ ...base, status: 'awaiting-approval', graphId: null, capacityPlanId: null, decisionExecutionInputIds: [] });
			continue;
		}
		const estimates = (await store.listStructuredAgentEstimatesForDecision(config.decisionId, { status: 'accepted' }))
			.filter((estimate) => estimate.projectId === config.projectId);
		if (!estimates.length || (config.requireLinkedProposal !== false && !estimates.some((estimate) => text(estimate.proposalId)))) {
			results.push({ ...base, status: 'awaiting-estimate', graphId: null, capacityPlanId: null, decisionExecutionInputIds: [] });
			continue;
		}
		const envelope = await store.first(`SELECT id, allocation_set_id FROM workday_capacity_envelopes WHERE team_id = ? AND workday_run_id = ? AND project_id = ? AND status = 'active' LIMIT 1`, [run.teamId, run.id, config.projectId]);
		if (!envelope) throw new CapacityGovernanceError('engineering_workflow_workday_envelope_missing', 'Engineering workflow promotion requires an active project workday envelope.', 409, { runId: run.id, projectId: config.projectId });
		const graph = await graphFor(store, config, run);
		const decisionExecutionInputIds = await createNodeInputs({
			store, run, config, graph, estimates, workdayId: String(envelope.id), allocationSetId: text(envelope.allocation_set_id),
		});
		const planId = `acp_${stableHash({ workflowId: config.id, graphId: graph.id, decisionExecutionInputIds })}`;
		const plans = await store.listAgentCapacityPlans(config.decisionId);
		let plan = plans.find((candidate) => candidate.id === planId) ?? null;
		if (!plan) plan = await store.createAgentCapacityPlan(config.decisionId, {
			id: planId, projectId: config.projectId, workDayId: String(envelope.id), allocationSetId: text(envelope.allocation_set_id),
			status: 'accepted', humanApprovalState: 'approved', decisionExecutionInputIds,
			metadata: { workflowPromotionId: config.id, workdayRunId: run.id, graphId: graph.id },
		});
		if (!plan) throw new CapacityGovernanceError('engineering_workflow_capacity_plan_failed', 'Engineering workflow capacity plan was not durably created.', 500, { planId });
		for (const prior of plans.filter((candidate) => candidate.id !== planId && ['accepted', 'scheduled', 'active'].includes(candidate.status))) {
			await store.updateAgentCapacityPlanStatus(prior.id, 'superseded', { reason: 'Superseded by a newer engineering workflow graph/input set.', metadata: { supersededByPlanId: planId } });
		}
		results.push({ ...base, status: 'promoted', graphId: graph.id, capacityPlanId: plan.id, decisionExecutionInputIds });
	}
	return results;
}
