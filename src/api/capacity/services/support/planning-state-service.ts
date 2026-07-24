import {
	type DecisionExecutionInput,
	type DecisionExecutionInputRecord,
	type DecisionExecutionInputStatus,
	type DecisionExecutionReadinessStatus,
	type DecisionPlanningStatus,
	type PlanningInputRequest,
	type PlanningInputRequestStatus,
} from '@treeseed/sdk/agent-capacity';
import { randomUUID } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { PlanningStateRepository } from '../../repositories/support/planning-state.ts';

type JsonRecord = Record<string, unknown>;

interface PlanningStateStore extends CapacityGovernanceDatabase {
	getProject(projectId: string): Promise<{ id: string; teamId: string } | null>;
	scopeHash(value: unknown): string;
}

export interface UpsertDecisionPlanningStatusInput {
	id?: string;
	projectId: string;
	decisionId: string;
	humanApprovalState?: string | null;
	executionReadiness?: DecisionExecutionReadinessStatus;
	planningInputsStatus?: PlanningInputRequestStatus;
	scopeHash?: string;
	scope?: JsonRecord;
	staleReason?: string | null;
	readyAt?: string | null;
	staleAt?: string | null;
	metadata?: JsonRecord;
}

export interface CreatePlanningInputRequestInput {
	id?: string;
	projectId: string;
	projectAgentClassId?: string | null;
	mode?: 'planning' | 'acting';
	status?: PlanningInputRequestStatus;
	scopeHash?: string;
	scope?: JsonRecord;
	prompt?: string | null;
	response?: JsonRecord;
	metadata?: JsonRecord;
	statusMetadata?: JsonRecord;
	humanApprovalState?: string;
	executionReadiness?: DecisionExecutionReadinessStatus;
	completedAt?: string | null;
	staleAt?: string | null;
}

export interface CreateDecisionExecutionInputInput {
	id?: string;
	projectId: string;
	projectAgentClassId?: string;
	mode?: 'planning' | 'acting';
	status?: DecisionExecutionInputStatus;
	scopeHash?: string;
	scope?: JsonRecord;
	input?: Partial<DecisionExecutionInput>;
	capacity?: JsonRecord;
	payload?: JsonRecord;
	metadata?: JsonRecord;
	humanApprovalState?: string;
	planningInputsStatus?: PlanningInputRequestStatus;
	acceptedAt?: string | null;
	revisionRequestedAt?: string | null;
	staleAt?: string | null;
}

function idPart(value: string, fallback: string) {
	return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || fallback;
}

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function optionalText(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function mode(value: unknown, fallback: 'planning' | 'acting') {
	const selected = value ?? fallback;
	if (selected !== 'planning' && selected !== 'acting') {
		throw new CapacityGovernanceError('decision_execution_input_mode_invalid', 'Mode must be planning or acting.', 400);
	}
	return selected;
}

function assertAcceptedActingProvenance(input: Pick<DecisionExecutionInput, 'mode' | 'workGraphNodeId'>, status: DecisionExecutionInputStatus) {
	if (status === 'accepted' && input.mode === 'acting' && !optionalText(input.workGraphNodeId)) {
		throw new CapacityGovernanceError(
			'decision_execution_input_work_graph_node_required',
			'Accepted acting execution input requires workGraphNodeId provenance.',
			409,
		);
	}
}

export function buildDecisionPlanningStatusRecord(input: {
	id?: string;
	teamId: string;
	projectId: string;
	decisionId: string;
	humanApprovalState?: string | null;
	executionReadiness: DecisionExecutionReadinessStatus;
	planningInputsStatus: PlanningInputRequestStatus;
	scopeHash: string;
	staleReason?: string | null;
	readyAt?: string | null;
	staleAt?: string | null;
	metadata?: JsonRecord;
	now: string;
}): DecisionPlanningStatus {
	return {
		id: input.id ?? `dps_${idPart(input.decisionId, 'decision')}`,
		teamId: input.teamId,
		projectId: input.projectId,
		decisionId: input.decisionId,
		humanApprovalState: input.humanApprovalState ?? null,
		executionReadiness: input.executionReadiness,
		planningInputsStatus: input.planningInputsStatus,
		scopeHash: input.scopeHash,
		staleReason: input.staleReason ?? null,
		readyAt: input.readyAt ?? (input.executionReadiness === 'ready' ? input.now : null),
		staleAt: input.staleAt ?? (input.executionReadiness === 'stale' ? input.now : null),
		metadata: input.metadata ?? {},
		createdAt: input.now,
		updatedAt: input.now,
	};
}

export class PlanningStateService {
	private readonly repository: PlanningStateRepository;

	constructor(private readonly store: PlanningStateStore) {
		this.repository = new PlanningStateRepository(store);
	}

	async upsertPlanningStatus(input: UpsertDecisionPlanningStatusInput) {
		const project = await this.store.getProject(input.projectId);
		if (!project) return null;
		if (!input.decisionId) throw new CapacityGovernanceError('decision_id_required', 'decisionId is required.', 400);
		const now = new Date().toISOString();
		const readiness = input.executionReadiness ?? 'draft';
		const scopeHash = input.scopeHash ?? this.store.scopeHash(input.scope ?? { projectId: project.id, decisionId: input.decisionId, metadata: input.metadata ?? {} });
		return this.repository.upsertPlanningStatus(buildDecisionPlanningStatusRecord({
			...input, teamId: project.teamId, projectId: project.id, scopeHash, now,
			decisionId: input.decisionId,
			executionReadiness: readiness,
			planningInputsStatus: input.planningInputsStatus ?? (readiness === 'ready' ? 'complete' : 'requested'),
		}));
	}

	getPlanningStatus(decisionId: string) { return this.repository.getPlanningStatus(decisionId); }
	listPlanningRequests(decisionId: string) { return this.repository.listPlanningRequests(decisionId); }
	listExecutionInputs(decisionId: string, filters: { status?: DecisionExecutionInputStatus | null } = {}) { return this.repository.listExecutionInputs(decisionId, filters); }
	getExecutionInput(id: string) { return this.repository.getExecutionInput(id); }

	async createPlanningRequest(decisionId: string, input: CreatePlanningInputRequestInput) {
		const project = await this.store.getProject(input.projectId);
		if (!project) return null;
		const now = new Date().toISOString();
		const requestMode = mode(input.mode, 'planning');
		const scopeHash = input.scopeHash ?? this.store.scopeHash(input.scope ?? { decisionId, projectId: project.id, projectAgentClassId: input.projectAgentClassId ?? null, mode: requestMode });
		const request: PlanningInputRequest = {
			id: input.id ?? randomUUID(), teamId: project.teamId, projectId: project.id, decisionId,
			projectAgentClassId: input.projectAgentClassId ?? null, mode: requestMode, status: input.status ?? 'requested',
			scopeHash, prompt: input.prompt ?? null, response: input.response ?? {}, metadata: input.metadata ?? {},
			requestedAt: now, completedAt: input.completedAt ?? null, staleAt: input.staleAt ?? null,
		};
		const planning = buildDecisionPlanningStatusRecord({
			teamId: project.teamId, projectId: project.id, decisionId, humanApprovalState: input.humanApprovalState ?? 'approved',
			executionReadiness: input.executionReadiness ?? 'blocked', planningInputsStatus: request.status,
			scopeHash, metadata: { source: 'planning_input_request', ...(input.statusMetadata ?? {}) }, now,
		});
		return this.repository.createPlanningRequest(request, planning);
	}

	async createExecutionInput(decisionId: string, input: CreateDecisionExecutionInputInput) {
		const project = await this.store.getProject(input.projectId);
		if (!project) return null;
		const selectedMode = mode(input.mode ?? input.input?.mode, 'acting');
		const projectAgentClassId = input.projectAgentClassId ?? input.input?.projectAgentClassId;
		if (!projectAgentClassId) throw new CapacityGovernanceError('project_agent_class_required', 'projectAgentClassId is required.', 400);
		const now = new Date().toISOString();
		const sourceInput = input.input ?? {};
		const normalizedInput: DecisionExecutionInput = {
			teamId: project.teamId, projectId: project.id, projectAgentClassId, mode: selectedMode,
			workGraphNodeId: optionalText(sourceInput.workGraphNodeId),
			taskId: optionalText(sourceInput.taskId), workDayId: optionalText(sourceInput.workDayId),
			agentId: optionalText(sourceInput.agentId), handlerId: optionalText(sourceInput.handlerId),
			capacity: {
				...record(sourceInput.capacity ?? input.capacity),
				mode: selectedMode,
				teamId: project.teamId,
				projectId: project.id,
			}, input: record(sourceInput.input ?? input.payload),
			metadata: record(sourceInput.metadata ?? input.metadata),
		};
		const scopeHash = input.scopeHash ?? this.store.scopeHash(input.scope ?? normalizedInput);
		const selectedStatus = input.status ?? 'proposed';
		assertAcceptedActingProvenance(normalizedInput, selectedStatus);
		const value: DecisionExecutionInputRecord = {
			id: input.id ?? randomUUID(), teamId: project.teamId, projectId: project.id, decisionId,
			workGraphNodeId: normalizedInput.workGraphNodeId ?? null,
			projectAgentClassId, mode: selectedMode, status: selectedStatus, scopeHash, input: normalizedInput,
			metadata: input.metadata ?? {}, acceptedAt: input.acceptedAt ?? (selectedStatus === 'accepted' ? now : null),
			revisionRequestedAt: input.revisionRequestedAt ?? null, staleAt: input.staleAt ?? null, createdAt: now, updatedAt: now,
		};
		const planning = buildDecisionPlanningStatusRecord({
			teamId: project.teamId, projectId: project.id, decisionId, humanApprovalState: input.humanApprovalState ?? 'approved',
			executionReadiness: selectedStatus === 'accepted' ? 'ready' : 'blocked', planningInputsStatus: input.planningInputsStatus ?? 'complete',
			scopeHash, metadata: { source: 'decision_execution_input' }, now,
		});
		return this.repository.createExecutionInput(value, planning);
	}

	async transitionExecutionInput(id: string, status: DecisionExecutionInputStatus, input: { reason?: string | null; metadata?: JsonRecord } = {}) {
		const existing = await this.repository.getExecutionInput(id);
		if (!existing) return null;
		assertAcceptedActingProvenance(existing.input, status);
		const now = new Date().toISOString();
		const value: DecisionExecutionInputRecord = {
			...existing, status,
			acceptedAt: status === 'accepted' ? existing.acceptedAt ?? now : existing.acceptedAt ?? null,
			revisionRequestedAt: status === 'revision_requested' ? existing.revisionRequestedAt ?? now : existing.revisionRequestedAt ?? null,
			metadata: { ...(existing.metadata ?? {}), ...(input.metadata ?? {}), reason: input.reason ?? null }, updatedAt: now,
		};
		const planning = buildDecisionPlanningStatusRecord({
			teamId: existing.teamId, projectId: existing.projectId, decisionId: existing.decisionId, humanApprovalState: 'approved',
			executionReadiness: status === 'accepted' ? 'ready' : 'blocked', planningInputsStatus: status === 'accepted' ? 'complete' : 'requested',
			scopeHash: existing.scopeHash, metadata: { latestExecutionInputId: existing.id, latestExecutionInputStatus: status }, now,
		});
		return this.repository.transitionExecutionInput(value, planning);
	}
}
