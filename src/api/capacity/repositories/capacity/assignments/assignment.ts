import type { ProviderAssignment } from '@treeseed/sdk/agent-capacity';
import { validateProviderAssignment } from '@treeseed/sdk/agent-capacity';
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

export function serializeProviderAssignmentRow(row: Row | null): DurableProviderAssignment | null {
	if (!row) return null;
	const id = text(row.id);
	const workspaceContext = json(row.workspace_context_json, {}, 'workspace_context_json', id);
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
		allocationSetId: row.allocation_set_id == null ? null : text(row.allocation_set_id),
		projectAgentClassId: text(row.project_agent_class_id),
		reservationId: row.reservation_id == null ? null : text(row.reservation_id),
		workDayId: row.work_day_id == null ? null : text(row.work_day_id),
		taskId: row.task_id == null ? null : text(row.task_id),
		mode: text(row.mode),
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
		fallbackOutputId: row.fallback_output_id == null ? null : text(row.fallback_output_id),
		treedxProxyHandle: json(row.treedx_proxy_handle_json, {}, 'treedx_proxy_handle_json', id),
		capabilityHandles: json(workspaceContext.capabilityHandles, {}, 'capability_handles', id),
		metadata: json(row.metadata_json, {}, 'metadata_json', id),
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

	async get(teamId: string, assignmentId: string): Promise<DurableProviderAssignment | null> {
		await this.database.ensureInitialized();
		return serializeProviderAssignmentRow(await this.database.first(
			`SELECT * FROM capacity_provider_assignments WHERE id = ? AND team_id = ? LIMIT 1`,
			[assignmentId, teamId],
		));
	}

	async list(teamId: string, filters: ProviderAssignmentFilters = {}): Promise<CapacityPage<DurableProviderAssignment>> {
		await this.database.ensureInitialized();
		const clauses = ['team_id = ?'];
		const values: unknown[] = [teamId];
		for (const [value, column] of [
			[filters.projectId, 'project_id'],
			[filters.providerId, 'capacity_provider_id'],
			[filters.status, 'status'],
			[filters.assignmentId, 'id'],
			[filters.workdayId, 'work_day_id'],
			[filters.executionProviderId, 'execution_provider_id'],
		] as const) {
			if (value) { clauses.push(`${column} = ?`); values.push(value); }
		}
		if (filters.cursor) {
			clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
			values.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id);
		}
		const limit = normalizeCapacityPageLimit(filters.limit);
		const rows = await this.database.all(
			`SELECT * FROM capacity_provider_assignments
			 WHERE ${clauses.join(' AND ')}
			 ORDER BY created_at DESC, id DESC LIMIT ?`,
			[...values, limit + 1],
		);
		const selected = rows.slice(0, limit);
		const hasMore = rows.length > limit;
		const last = selected.at(-1);
		return {
			items: selected.map((row) => serializeProviderAssignmentRow(row) as DurableProviderAssignment),
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
