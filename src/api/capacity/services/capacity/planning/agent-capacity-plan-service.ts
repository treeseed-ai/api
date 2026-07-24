import {
	buildAgentCapacityPlanDraft,
	type AgentCapacityPlanRecord,
	type DecisionExecutionInputRecord,
	type DurableAgentCapacityPlanStatus,
} from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import {
	AgentCapacityPlanRepository,
	type AgentCapacityPlanTransitionInput,
} from '../../../repositories/capacity/planning/agent-capacity-plan.ts';

type JsonRecord = Record<string, unknown>;

interface AgentCapacityPlanStore extends CapacityGovernanceDatabase {
	getProject(projectId: string): Promise<{ id: string; teamId: string } | null>;
	listDecisionExecutionInputs(decisionId: string, filters: { status: 'accepted' }): Promise<DecisionExecutionInputRecord[]>;
	scopeHash(value: unknown): string;
	upsertDecisionPlanningStatus(input: {
		projectId: string;
		decisionId: string;
		humanApprovalState: string;
		executionReadiness: 'ready' | 'blocked';
		planningInputsStatus: 'complete';
		scopeHash: string;
		metadata: JsonRecord;
	}): Promise<unknown>;
}

export interface CreateAgentCapacityPlanInput {
	id?: string;
	projectId: string;
	scopeHash?: string;
	allocationSetId?: string | null;
	workDayId?: string | null;
	status?: DurableAgentCapacityPlanStatus;
	humanApprovalState?: string;
	review?: JsonRecord;
	metadata?: JsonRecord;
	decisionExecutionInputIds?: string[];
}

function idPart(value: string, fallback = 'item') {
	return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || fallback;
}

function readiness(status: DurableAgentCapacityPlanStatus) {
	return ['accepted', 'scheduled', 'active'].includes(status) ? 'ready' as const : 'blocked' as const;
}

function isActivePlan(plan: AgentCapacityPlanRecord) {
	return ['accepted', 'scheduled', 'active'].includes(plan.status);
}

export class AgentCapacityPlanService {
	private readonly repository: AgentCapacityPlanRepository;

	constructor(private readonly store: AgentCapacityPlanStore) {
		this.repository = new AgentCapacityPlanRepository(store);
	}

	get(planId: string) {
		return this.repository.get(planId);
	}

	list(decisionId: string, filters: { status?: DurableAgentCapacityPlanStatus | null } = {}) {
		return this.repository.list(decisionId, filters);
	}

	async create(decisionId: string, input: CreateAgentCapacityPlanInput): Promise<AgentCapacityPlanRecord | null> {
		const project = await this.store.getProject(input.projectId);
		if (!project) return null;
		const acceptedInputs = await this.store.listDecisionExecutionInputs(decisionId, { status: 'accepted' });
		const requestedIds = Array.isArray(input.decisionExecutionInputIds)
			? [...new Set(input.decisionExecutionInputIds.map(String).map((id) => id.trim()).filter(Boolean))]
			: [];
		const executionInputs = requestedIds.length
			? acceptedInputs.filter((entry) => requestedIds.includes(entry.id))
			: acceptedInputs;
		const missingInputIds = requestedIds.filter((id) => !executionInputs.some((entry) => entry.id === id));
		if (missingInputIds.length) {
			throw new CapacityGovernanceError('agent_capacity_plan_execution_input_missing', 'Requested accepted decision execution inputs are unavailable.', 409, { decisionId, projectId: project.id, missingInputIds });
		}
		if (executionInputs.length === 0) {
			throw new CapacityGovernanceError('agent_capacity_plan_execution_input_required', 'At least one accepted decision execution input is required to build a capacity plan.', 409, { decisionId, projectId: project.id });
		}
		const actingWithoutGraphNode = executionInputs.find((entry) => entry.mode === 'acting' && !entry.input.workGraphNodeId?.trim());
		if (actingWithoutGraphNode) {
			throw new CapacityGovernanceError(
				'agent_capacity_plan_work_graph_node_required',
				'Accepted acting execution input requires workGraphNodeId provenance before capacity planning.',
				409,
				{ decisionId, projectId: project.id, decisionExecutionInputId: actingWithoutGraphNode.id },
			);
		}
		const now = new Date().toISOString();
		const scopeHash = input.scopeHash ?? this.store.scopeHash({
			decisionId,
			projectId: project.id,
			executionInputIds: executionInputs.map((entry) => entry.id).sort(),
			allocationSetId: input.allocationSetId ?? null,
			workDayId: input.workDayId ?? null,
		});
		const plan = buildAgentCapacityPlanDraft({
			id: input.id ?? `acp_${idPart(decisionId)}_${idPart(scopeHash)}`,
			teamId: project.teamId,
			projectId: project.id,
			decisionId,
			scopeHash,
			executionInputs,
			allocationSetId: input.allocationSetId ?? null,
			workDayId: input.workDayId ?? null,
			status: input.status ?? 'draft',
			metadata: {
				...(input.metadata ?? {}),
				source: 'accepted_decision_execution_inputs',
				executionInputIds: executionInputs.map((entry) => entry.id),
			},
			now,
		});
		const persisted = await this.repository.upsert(plan, input.review ?? {});
		if (!persisted) throw new CapacityGovernanceError('agent_capacity_plan_persistence_failed', 'Agent capacity plan was not persisted.', 500, { planId: plan.id });
		await this.recordPlanningStatus(persisted, input.humanApprovalState ?? 'approved');
		return persisted;
	}

	async transition(planId: string, status: DurableAgentCapacityPlanStatus, input: AgentCapacityPlanTransitionInput = {}) {
		const updated = await this.repository.transition(planId, status, input);
		if (!updated) return null;
		const authoritative = isActivePlan(updated)
			? updated
			: (await this.repository.list(updated.decisionId)).find(isActivePlan) ?? updated;
		await this.recordPlanningStatus(authoritative, 'approved');
		return updated;
	}

	private async recordPlanningStatus(plan: AgentCapacityPlanRecord, humanApprovalState: string) {
		await this.store.upsertDecisionPlanningStatus({
			projectId: plan.projectId,
			decisionId: plan.decisionId,
			humanApprovalState,
			executionReadiness: readiness(plan.status),
			planningInputsStatus: 'complete',
			scopeHash: plan.scopeHash,
			metadata: { source: 'agent_capacity_plan', latestCapacityPlanId: plan.id, latestCapacityPlanStatus: plan.status },
		});
	}
}
