import type {
	DecisionExecutionInputRecord,
	DecisionExecutionInputStatus,
	DecisionExecutionReadinessStatus,
	DecisionPlanningStatus,
	PlanningInputRequest,
	PlanningInputRequestStatus,
} from '@treeseed/sdk/agent-capacity';
import { decodeDurableJsonObject } from '../durable-json.ts';
import type { CapacityDatabaseOperation, CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';

type Row = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

const READINESS = new Set<DecisionExecutionReadinessStatus>(['draft', 'blocked', 'ready', 'stale', 'waived']);
const PLANNING_STATUSES = new Set<PlanningInputRequestStatus>(['requested', 'complete', 'waived', 'rejected', 'stale']);
const EXECUTION_STATUSES = new Set<DecisionExecutionInputStatus>(['proposed', 'accepted', 'revision_requested', 'rejected', 'stale']);

function text(value: unknown): string { return value == null ? '' : String(value); }
function nullableText(value: unknown): string | null { return value == null ? null : String(value); }
function required(row: Row, id: string, field: string, column: string) {
	const value = text(row[column]);
	if (!value) throw new CapacityGovernanceError('planning_state_field_invalid', `Planning state ${id || '(unknown)'} requires ${field}.`, 500, { id: id || null, field });
	return value;
}
function enumValue<T extends string>(value: unknown, allowed: Set<T>, code: string): T {
	const candidate = text(value) as T;
	if (!allowed.has(candidate)) throw new CapacityGovernanceError(code, `Unknown planning state value ${candidate || '(empty)'}.`, 500);
	return candidate;
}
function object(row: Row, id: string, column: string) {
	return decodeDurableJsonObject(row[column], { owner: 'planning state', ownerId: id, column });
}

export function serializeDecisionPlanningStatusRow(row: Row | null): DecisionPlanningStatus | null {
	if (!row) return null;
	const id = text(row.id);
	return {
		id,
		teamId: required(row, id, 'teamId', 'team_id'),
		projectId: required(row, id, 'projectId', 'project_id'),
		decisionId: required(row, id, 'decisionId', 'decision_id'),
		humanApprovalState: nullableText(row.human_approval_state),
		executionReadiness: enumValue(row.execution_readiness, READINESS, 'decision_execution_readiness_invalid'),
		planningInputsStatus: enumValue(row.planning_inputs_status, PLANNING_STATUSES, 'planning_input_status_invalid'),
		scopeHash: required(row, id, 'scopeHash', 'scope_hash'),
		staleReason: nullableText(row.stale_reason),
		readyAt: nullableText(row.ready_at),
		staleAt: nullableText(row.stale_at),
		metadata: object(row, id, 'metadata_json'),
		createdAt: required(row, id, 'createdAt', 'created_at'),
		updatedAt: required(row, id, 'updatedAt', 'updated_at'),
	};
}

export function serializePlanningInputRequestRow(row: Row | null): PlanningInputRequest | null {
	if (!row) return null;
	const id = text(row.id);
	const mode = text(row.mode);
	if (mode !== 'planning' && mode !== 'acting') throw new CapacityGovernanceError('planning_input_mode_invalid', `Planning input request ${id} has invalid mode.`, 500, { id });
	return {
		id,
		teamId: required(row, id, 'teamId', 'team_id'),
		projectId: required(row, id, 'projectId', 'project_id'),
		decisionId: required(row, id, 'decisionId', 'decision_id'),
		projectAgentClassId: nullableText(row.project_agent_class_id),
		mode,
		status: enumValue(row.status, PLANNING_STATUSES, 'planning_input_status_invalid'),
		scopeHash: required(row, id, 'scopeHash', 'scope_hash'),
		prompt: nullableText(row.prompt),
		response: object(row, id, 'response_json'),
		metadata: object(row, id, 'metadata_json'),
		requestedAt: required(row, id, 'requestedAt', 'requested_at'),
		completedAt: nullableText(row.completed_at),
		staleAt: nullableText(row.stale_at),
	};
}

export function serializeDecisionExecutionInputRow(row: Row | null): DecisionExecutionInputRecord | null {
	if (!row) return null;
	const id = text(row.id);
	const mode = text(row.mode);
	if (mode !== 'planning' && mode !== 'acting') throw new CapacityGovernanceError('decision_execution_input_mode_invalid', `Decision execution input ${id} has invalid mode.`, 500, { id });
	return {
		id,
		teamId: required(row, id, 'teamId', 'team_id'),
		projectId: required(row, id, 'projectId', 'project_id'),
		decisionId: required(row, id, 'decisionId', 'decision_id'),
		workGraphNodeId: nullableText(row.work_graph_node_id),
		projectAgentClassId: required(row, id, 'projectAgentClassId', 'project_agent_class_id'),
		mode,
		status: enumValue(row.status, EXECUTION_STATUSES, 'decision_execution_input_status_invalid'),
		scopeHash: required(row, id, 'scopeHash', 'scope_hash'),
		input: object(row, id, 'input_json') as unknown as DecisionExecutionInputRecord['input'],
		metadata: object(row, id, 'metadata_json'),
		acceptedAt: nullableText(row.accepted_at),
		revisionRequestedAt: nullableText(row.revision_requested_at),
		staleAt: nullableText(row.stale_at),
		createdAt: required(row, id, 'createdAt', 'created_at'),
		updatedAt: required(row, id, 'updatedAt', 'updated_at'),
	};
}

export function decisionPlanningStatusOperation(value: DecisionPlanningStatus): CapacityDatabaseOperation {
	const now = value.updatedAt ?? new Date().toISOString();
	return {
		query: `INSERT INTO decision_planning_statuses (
			id, team_id, project_id, decision_id, human_approval_state, execution_readiness, planning_inputs_status,
			scope_hash, stale_reason, ready_at, stale_at, metadata_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (decision_id) DO UPDATE SET
			team_id = EXCLUDED.team_id, project_id = EXCLUDED.project_id,
			human_approval_state = EXCLUDED.human_approval_state, execution_readiness = EXCLUDED.execution_readiness,
			planning_inputs_status = EXCLUDED.planning_inputs_status, scope_hash = EXCLUDED.scope_hash,
			stale_reason = EXCLUDED.stale_reason, ready_at = EXCLUDED.ready_at, stale_at = EXCLUDED.stale_at,
			metadata_json = EXCLUDED.metadata_json, updated_at = EXCLUDED.updated_at`,
		params: [
			value.id, value.teamId, value.projectId, value.decisionId, value.humanApprovalState ?? null,
			value.executionReadiness, value.planningInputsStatus, value.scopeHash, value.staleReason ?? null,
			value.readyAt ?? null, value.staleAt ?? null, JSON.stringify(value.metadata ?? {}), value.createdAt ?? now, now,
		],
	};
}

export class PlanningStateRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async upsertPlanningStatus(value: DecisionPlanningStatus) {
		await this.database.ensureInitialized();
		await this.database.batch([decisionPlanningStatusOperation(value)]);
		return this.getPlanningStatus(value.decisionId);
	}

	async getPlanningStatus(decisionId: string) {
		await this.database.ensureInitialized();
		return serializeDecisionPlanningStatusRow(await this.database.first(
			`SELECT * FROM decision_planning_statuses WHERE decision_id = ? LIMIT 1`, [decisionId],
		));
	}

	async createPlanningRequest(request: PlanningInputRequest, planning: DecisionPlanningStatus) {
		await this.database.ensureInitialized();
		await this.database.batch([
			decisionPlanningStatusOperation(planning),
			{
				query: `INSERT INTO planning_input_requests (
					id, team_id, project_id, decision_id, project_agent_class_id, mode, status, scope_hash,
					prompt, response_json, metadata_json, requested_at, completed_at, stale_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET
					team_id = EXCLUDED.team_id, project_id = EXCLUDED.project_id, decision_id = EXCLUDED.decision_id,
					project_agent_class_id = EXCLUDED.project_agent_class_id, mode = EXCLUDED.mode, status = EXCLUDED.status,
					scope_hash = EXCLUDED.scope_hash, prompt = EXCLUDED.prompt, response_json = EXCLUDED.response_json,
					metadata_json = EXCLUDED.metadata_json, completed_at = EXCLUDED.completed_at, stale_at = EXCLUDED.stale_at`,
				params: [
					request.id, request.teamId, request.projectId, request.decisionId, request.projectAgentClassId ?? null,
					request.mode, request.status, request.scopeHash, request.prompt ?? null, JSON.stringify(request.response ?? {}),
					JSON.stringify(request.metadata ?? {}), request.requestedAt, request.completedAt ?? null, request.staleAt ?? null,
				],
			},
		]);
		return this.getPlanningRequest(request.id);
	}

	async getPlanningRequest(id: string) {
		return serializePlanningInputRequestRow(await this.database.first(`SELECT * FROM planning_input_requests WHERE id = ? LIMIT 1`, [id]));
	}

	async listPlanningRequests(decisionId: string) {
		await this.database.ensureInitialized();
		const rows = await this.database.all(`SELECT * FROM planning_input_requests WHERE decision_id = ? ORDER BY requested_at DESC, id DESC LIMIT 200`, [decisionId]);
		return rows.map((row) => serializePlanningInputRequestRow(row) as PlanningInputRequest);
	}

	async createExecutionInput(value: DecisionExecutionInputRecord, planning: DecisionPlanningStatus) {
		await this.database.ensureInitialized();
		const now = value.updatedAt ?? new Date().toISOString();
		const workGraphNodeId = value.workGraphNodeId ?? value.input.workGraphNodeId ?? null;
		const sameSlot = workGraphNodeId
			? 'work_graph_node_id = ?'
			: 'work_graph_node_id IS NULL';
		const slotParams = workGraphNodeId ? [workGraphNodeId] : [];
		await this.database.batch([
			decisionPlanningStatusOperation(planning),
			{
				query: `UPDATE agent_capacity_plans SET status = 'superseded', superseded_at = COALESCE(superseded_at, ?), updated_at = ?
				 WHERE decision_id = ? AND project_id = ? AND status IN ('draft','accepted','scheduled','active')
				 AND EXISTS (SELECT 1 FROM decision_execution_inputs prior WHERE prior.decision_id = ? AND prior.project_id = ?
				 AND prior.${sameSlot} AND prior.scope_hash != ? AND prior.status IN ('proposed','accepted'))`,
				params: [now, now, value.decisionId, value.projectId, value.decisionId, value.projectId, ...slotParams, value.scopeHash],
			},
			{ query: `UPDATE decision_execution_inputs SET status = 'stale', stale_at = COALESCE(stale_at, ?), updated_at = ? WHERE decision_id = ? AND project_id = ? AND ${sameSlot} AND scope_hash != ? AND status IN ('proposed','accepted')`, params: [now, now, value.decisionId, value.projectId, ...slotParams, value.scopeHash] },
			{
				query: `INSERT INTO decision_execution_inputs (
					id, team_id, project_id, decision_id, work_graph_node_id, project_agent_class_id, mode, status, scope_hash,
					input_json, metadata_json, accepted_at, revision_requested_at, stale_at, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET
					team_id = EXCLUDED.team_id, project_id = EXCLUDED.project_id, decision_id = EXCLUDED.decision_id,
					work_graph_node_id = EXCLUDED.work_graph_node_id,
					project_agent_class_id = EXCLUDED.project_agent_class_id, mode = EXCLUDED.mode, status = EXCLUDED.status,
					scope_hash = EXCLUDED.scope_hash, input_json = EXCLUDED.input_json, metadata_json = EXCLUDED.metadata_json,
					accepted_at = EXCLUDED.accepted_at, revision_requested_at = EXCLUDED.revision_requested_at,
					stale_at = EXCLUDED.stale_at, updated_at = EXCLUDED.updated_at`,
				params: [
					value.id, value.teamId, value.projectId, value.decisionId, workGraphNodeId, value.projectAgentClassId, value.mode,
					value.status, value.scopeHash, JSON.stringify(value.input), JSON.stringify(value.metadata ?? {}),
					value.acceptedAt ?? null, value.revisionRequestedAt ?? null, value.staleAt ?? null, value.createdAt ?? now, now,
				],
			},
		]);
		return this.getExecutionInput(value.id);
	}

	async listExecutionInputs(decisionId: string, filters: { status?: DecisionExecutionInputStatus | null } = {}) {
		await this.database.ensureInitialized();
		const values: unknown[] = [decisionId];
		const statusClause = filters.status ? ' AND status = ?' : '';
		if (filters.status) values.push(enumValue(filters.status, EXECUTION_STATUSES, 'decision_execution_input_status_invalid'));
		const rows = await this.database.all(`SELECT * FROM decision_execution_inputs WHERE decision_id = ?${statusClause} ORDER BY created_at DESC, id DESC LIMIT 200`, values);
		return rows.map((row) => serializeDecisionExecutionInputRow(row) as DecisionExecutionInputRecord);
	}

	async getExecutionInput(id: string) {
		await this.database.ensureInitialized();
		return serializeDecisionExecutionInputRow(await this.database.first(`SELECT * FROM decision_execution_inputs WHERE id = ? LIMIT 1`, [id]));
	}

	async transitionExecutionInput(value: DecisionExecutionInputRecord, planning: DecisionPlanningStatus) {
		await this.database.ensureInitialized();
		await this.database.batch([
			decisionPlanningStatusOperation(planning),
			{
				query: `UPDATE decision_execution_inputs SET status = ?, accepted_at = ?, revision_requested_at = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
				params: [value.status, value.acceptedAt ?? null, value.revisionRequestedAt ?? null, JSON.stringify(value.metadata ?? {}), value.updatedAt, value.id],
			},
		]);
		return this.getExecutionInput(value.id);
	}
}
