import type { ProviderAssignment } from '@treeseed/sdk/agent-capacity';
import { assignmentAttemptSchema, assignmentResultSchema, validateProviderAssignment } from '@treeseed/sdk/agent-capacity';
import {
encodeCapacityPageCursor,
normalizeCapacityPageLimit,
type CapacityPage,
type CapacityPageCursor,
} from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';

type Row = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

export type DurableProviderAssignment = ProviderAssignment;

export interface ProviderAssignmentFilters {
	projectId?: string | null;
	providerId?: string | null;
	status?: string | null;
	assignmentId?: string | null;
	workdayId?: string | null;
	executionProviderId?: string | null;
	limit?: unknown;
	cursor?: CapacityPageCursor | null;
}

function json(value: unknown, fallback: JsonRecord, field: string, assignmentId: string): JsonRecord {
	if (value == null || value === '') return fallback;
	if (typeof value !== 'string') {
		if (typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
		throw new CapacityGovernanceError('provider_assignment_json_invalid', `Assignment ${assignmentId} has invalid ${field}.`, 500, { assignmentId, field });
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonRecord;
	} catch {
		// The typed error below preserves assignment and field identity.
	}
	throw new CapacityGovernanceError('provider_assignment_json_invalid', `Assignment ${assignmentId} has invalid ${field}.`, 500, { assignmentId, field });
}

function text(value: unknown): string {
	return value == null ? '' : String(value);
}

function typedJson<T>(value: unknown, field: string, assignmentId: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; code: string; message: string }[] } } }): T | null {
	if (value == null || value === '') return null;
	let decoded = value;
	if (typeof value === 'string') {
		try { decoded = JSON.parse(value); }
		catch { throw new CapacityGovernanceError('provider_assignment_json_invalid', `Assignment ${assignmentId} has invalid ${field}.`, 500, { assignmentId, field }); }
	}
	const parsed = schema.safeParse(decoded);
	if (!parsed.success) {
		const issue = parsed.error.issues[0]!;
		throw new CapacityGovernanceError('provider_assignment_contract_invalid',
			`Assignment ${assignmentId} has invalid ${field} at ${issue.path.join('.')}: ${issue.message}`,
			500, { assignmentId, field, diagnostics: parsed.error.issues.map(({ path, code, message }) => ({ path, code, message })) });
	}
	return parsed.data ?? null;
}

export function serializeProviderAssignmentRow(row: Row | null, inspection = false): DurableProviderAssignment | null {
	try { return serializeExecutableAssignmentRow(row); }
	catch (error) {
		if (!inspection || !row || !(error instanceof CapacityGovernanceError) || error.code !== 'provider_assignment_contract_invalid') throw error;
		// Inspection/cancellation never makes an invalid snapshot executable.
		return serializeExecutableAssignmentRow({ ...row, assignment_attempt_json: null, assignment_result_json: null,
			explanation_json: { ...json(row.explanation_json, {}, 'explanation_json', text(row.id)),
				snapshotValidation: { valid: false, ...error.details } } });
	}
}

function serializeExecutableAssignmentRow(row: Row | null): DurableProviderAssignment | null {
	if (!row) return null;
	const id = text(row.id);
	const workspaceContext = json(row.workspace_context_json, {}, 'workspace_context_json', id);
	const metadata = json(row.metadata_json, {}, 'metadata_json', id);
	const workdayExecutionMode = row.workday_execution_mode == null ? null : text(row.workday_execution_mode);
	if (workdayExecutionMode && workdayExecutionMode !== 'simulation' && workdayExecutionMode !== 'production') {
		throw new CapacityGovernanceError('provider_assignment_workday_mode_invalid', `Assignment ${id} has an invalid authoritative workday mode.`, 500, { assignmentId: id });
	}
	const assignment = {
		id,
		membershipId: text(row.membership_id),
		stateVersion: Number(row.state_version ?? 1),
		teamId: text(row.team_id),
		projectId: text(row.project_id),
		capacityProviderId: text(row.capacity_provider_id),
		providerSessionId: row.provider_session_id == null ? null : text(row.provider_session_id),
		executionProviderId: row.execution_provider_id == null ? null : text(row.execution_provider_id),
		laneId: row.lane_id == null ? null : text(row.lane_id),
		lanePurpose: row.lane_purpose == null ? null : text(row.lane_purpose) as DurableProviderAssignment['lanePurpose'],
		communicationOverflow: Number(row.communication_overflow) === 1,
		executionKind: text(row.execution_kind) as DurableProviderAssignment['executionKind'],
		triggerKind: text(row.trigger_kind) as DurableProviderAssignment['triggerKind'],
		invocationId: row.invocation_id == null ? null : text(row.invocation_id),
		parentWorkdayId: row.parent_workday_id == null ? null : text(row.parent_workday_id),
		parentAssignmentId: row.parent_assignment_id == null ? null : text(row.parent_assignment_id),
		handoffRootId: row.handoff_root_id == null ? null : text(row.handoff_root_id),
		handoffParentId: row.handoff_parent_id == null ? null : text(row.handoff_parent_id),
		handoffDepth: Number(row.handoff_depth ?? 0),
		sourceMessageRefs: (() => { try { return JSON.parse(text(row.source_message_refs_json) || '[]') as string[]; } catch { return []; } })(),
		operationHandoffId: row.operation_handoff_id == null ? null : text(row.operation_handoff_id),
		allocationSetId: row.allocation_set_id == null ? null : text(row.allocation_set_id),
		projectAgentClassId: text(row.project_agent_class_id),
		reservationId: row.reservation_id == null ? null : text(row.reservation_id),
		workDayId: row.work_day_id == null ? null : text(row.work_day_id),
		taskId: row.task_id == null ? null : text(row.task_id),
		mode: text(row.mode),
		...(workdayExecutionMode ? { executionMode: workdayExecutionMode } : {}),
		status: text(row.status),
		leaseState: text(row.lease_state),
		leaseExpiresAt: row.lease_expires_at == null ? null : text(row.lease_expires_at),
		leaseToken: row.lease_token == null ? null : text(row.lease_token),
		leaseRenewedAt: row.lease_renewed_at == null ? null : text(row.lease_renewed_at),
		runnerId: row.runner_id == null ? null : text(row.runner_id),
		agentId: row.agent_id == null ? null : text(row.agent_id),
		handlerId: row.handler_id == null ? null : text(row.handler_id),
		capacityEnvelope: json(row.capacity_envelope_json, {}, 'capacity_envelope_json', id) as unknown as DurableProviderAssignment['capacityEnvelope'],
		decisionInput: json(row.decision_input_json, {}, 'decision_input_json', id),
		workspaceContext,
		allowedOutputs: json(row.allowed_outputs_json, {}, 'allowed_outputs_json', id),
		explanation: json(row.explanation_json, {}, 'explanation_json', id),
		attemptCount: Number(row.attempt_count ?? 0),
		assignedAt: row.assigned_at == null ? null : text(row.assigned_at),
		claimedAt: row.claimed_at == null ? null : text(row.claimed_at),
		completedAt: row.completed_at == null ? null : text(row.completed_at),
		returnedAt: row.returned_at == null ? null : text(row.returned_at),
		failedAt: row.failed_at == null ? null : text(row.failed_at),
		lifecycleReason: row.lifecycle_reason == null ? null : text(row.lifecycle_reason),
		lifecycleCode: row.lifecycle_code == null ? null : text(row.lifecycle_code),
		lifecycleOutput: json(row.lifecycle_output_json, {}, 'lifecycle_output_json', id),
		synthesizedFrom: row.synthesized_from == null ? null : text(row.synthesized_from),
		synthesisKey: row.synthesis_key == null ? null : text(row.synthesis_key),
		decisionId: row.decision_id == null ? null : text(row.decision_id),
		proposalId: row.proposal_id == null ? null : text(row.proposal_id),
		graphRevision: row.graph_revision == null ? null : Number(row.graph_revision),
		executionNodeId: row.execution_node_id == null ? null : text(row.execution_node_id),
		executionNodeRevision: row.execution_node_revision == null ? null : Number(row.execution_node_revision),
		assignmentAttempt: typedJson(row.assignment_attempt_json, 'assignment_attempt_json', id, assignmentAttemptSchema),
		assignmentResult: typedJson(row.assignment_result_json, 'assignment_result_json', id, assignmentResultSchema),
		fallbackOutputId: row.fallback_output_id == null ? null : text(row.fallback_output_id),
		treedxProxyHandle: json(row.treedx_proxy_handle_json, {}, 'treedx_proxy_handle_json', id),
		capabilityHandles: json(workspaceContext.capabilityHandles, {}, 'capability_handles', id),
		metadata,
		createdAt: text(row.created_at),
		updatedAt: text(row.updated_at),
	};
	const validation = validateProviderAssignment(assignment);
	if (!validation.ok) {
		const first = validation.diagnostics[0]!;
		throw new CapacityGovernanceError(first.code, `Assignment ${id || 'unknown'} is corrupt at ${first.path}: ${first.message}`, 500, {
			assignmentId: id || null,
			path: first.path,
			persistedColumns: Object.keys(row).sort(),
		});
	}
	return assignment as ProviderAssignment;
}

export class ProviderAssignmentRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	/** Cancellation must revoke persisted authority even when an executable snapshot is corrupt. */
	async getForCancellation(teamId: string, assignmentId: string): Promise<DurableProviderAssignment | null> {
		await this.database.ensureInitialized();
		const row = await this.database.first(`SELECT assignment.*,run.execution_mode AS workday_execution_mode
			FROM capacity_provider_assignments assignment
			LEFT JOIN capacity_workday_runs run ON run.id=assignment.work_day_id AND run.team_id=assignment.team_id
			WHERE assignment.id=? AND assignment.team_id=? LIMIT 1`, [assignmentId, teamId]);
		return serializeProviderAssignmentRow(row ? { ...row, assignment_attempt_json: null, assignment_result_json: null } : null);
	}

	async get(teamId: string, assignmentId: string, inspection = false): Promise<DurableProviderAssignment | null> {
		await this.database.ensureInitialized();
		return serializeProviderAssignmentRow(await this.database.first(
			`SELECT assignment.*,run.execution_mode AS workday_execution_mode
			 FROM capacity_provider_assignments assignment
			 LEFT JOIN capacity_workday_runs run ON run.id=assignment.work_day_id AND run.team_id=assignment.team_id
			 WHERE assignment.id = ? AND assignment.team_id = ? LIMIT 1`,
			[assignmentId, teamId],
		), inspection);
	}

	async list(teamId: string, filters: ProviderAssignmentFilters = {}): Promise<CapacityPage<DurableProviderAssignment>> {
		await this.database.ensureInitialized();
		const clauses = ['assignment.team_id = ?'];
		const values: unknown[] = [teamId];
		for (const [value, column] of [
			[filters.projectId, 'assignment.project_id'],
			[filters.providerId, 'assignment.capacity_provider_id'],
			[filters.status, 'assignment.status'],
			[filters.assignmentId, 'assignment.id'],
			[filters.workdayId, 'assignment.work_day_id'],
			[filters.executionProviderId, 'assignment.execution_provider_id'],
		] as const) {
			if (value) { clauses.push(`${column} = ?`); values.push(value); }
		}
		if (filters.cursor) {
			clauses.push('(assignment.created_at < ? OR (assignment.created_at = ? AND assignment.id < ?))');
			values.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id);
		}
		const limit = normalizeCapacityPageLimit(filters.limit);
		const rows = await this.database.all(
			`SELECT assignment.*,run.execution_mode AS workday_execution_mode FROM capacity_provider_assignments assignment
			 LEFT JOIN capacity_workday_runs run ON run.id=assignment.work_day_id AND run.team_id=assignment.team_id
			 WHERE ${clauses.join(' AND ')}
			 ORDER BY assignment.created_at DESC, assignment.id DESC LIMIT ?`,
			[...values, limit + 1],
		);
		const selected = rows.slice(0, limit);
		const hasMore = rows.length > limit;
		const last = selected.at(-1);
		return {
			items: selected.map((row) => serializeProviderAssignmentRow(row, true) as DurableProviderAssignment),
			page: {
				limit,
				hasMore,
				nextCursor: hasMore && last
					? encodeCapacityPageCursor({ createdAt: text(last.created_at), id: text(last.id) })
					: null,
			},
		};
	}
}
