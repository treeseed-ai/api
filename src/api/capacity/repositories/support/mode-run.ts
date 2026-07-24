import { randomUUID } from 'node:crypto';
import type { AgentModeRun, ProviderAssignment } from '@treeseed/sdk/agent-capacity';
import { validateAgentModeRun } from '@treeseed/sdk/agent-capacity';
import {
	encodeCapacityPageCursor,
	normalizeCapacityPageLimit,
	type CapacityPage,
	type CapacityPageCursor,
} from '@treeseed/sdk/capacity-pagination';
import type { CapacityDatabaseOperation, CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';

type JsonRecord = Record<string, unknown>;

interface ModeRunRepositoryDatabase extends CapacityGovernanceDatabase {
	getProviderAssignment(teamId: string, assignmentId: string): Promise<ProviderAssignment | null>;
}

interface AgentModeRunRow extends Record<string, unknown> {
	id: string;
	team_id: string;
	project_id: string;
	provider_assignment_id: string;
	capacity_provider_id: string;
	project_agent_class_id: string;
	mode: string;
	status: string;
	created_at: string;
}

export interface AgentModeRunListFilters {
	mode?: string | null;
	assignmentId?: string | null;
	workDayId?: string | null;
	limit?: unknown;
	cursor?: CapacityPageCursor | null;
}

export interface AgentModeRunWrite {
	id?: string;
	teamId: string;
	providerAssignmentId: string;
	executionProviderId?: string | null;
	agentId?: string | null;
	handlerId?: string | null;
	mode?: AgentModeRun['mode'];
	status?: AgentModeRun['status'];
	selectedInput?: JsonRecord;
	capacityEnvelope?: JsonRecord;
	outputs?: JsonRecord;
	traceRefs?: JsonRecord;
	usageActual?: JsonRecord;
	validation?: JsonRecord;
	fallbackReason?: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
	failedAt?: string | null;
	metadata?: JsonRecord;
	capacityUsageActualId?: string | null;
}

function record(value: unknown, field: string, modeRunId: string): JsonRecord {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
	throw new CapacityGovernanceError('agent_mode_run_json_invalid', `Mode run ${modeRunId} has invalid ${field}.`, 500, { modeRunId, field });
}

function jsonRecord(value: unknown, field: string, modeRunId: string): JsonRecord {
	if (typeof value !== 'string') return record(value, field, modeRunId);
	try {
		return record(JSON.parse(value), field, modeRunId);
	} catch {
		throw new CapacityGovernanceError('agent_mode_run_json_invalid', `Mode run ${modeRunId} has invalid ${field}.`, 500, { modeRunId, field });
	}
}

function text(value: unknown): string {
	return value == null ? '' : String(value);
}

function nullableText(value: unknown): string | null {
	return typeof value === 'string' && value ? value : null;
}

export function serializeAgentModeRunRow(row: Record<string, unknown> | null): AgentModeRun | null {
	if (!row) return null;
	const id = text(row.id);
	const modeRun = {
		id,
		teamId: text(row.team_id),
		projectId: text(row.project_id),
		providerAssignmentId: text(row.provider_assignment_id),
		capacityProviderId: text(row.capacity_provider_id),
		executionProviderId: nullableText(row.execution_provider_id),
		projectAgentClassId: text(row.project_agent_class_id),
		agentId: nullableText(row.agent_id),
		handlerId: nullableText(row.handler_id),
		mode: text(row.mode),
		status: text(row.status),
		selectedInput: jsonRecord(row.selected_input_json, 'selected_input_json', id),
		capacityEnvelope: jsonRecord(row.capacity_envelope_json, 'capacity_envelope_json', id) as unknown as AgentModeRun['capacityEnvelope'],
		outputs: jsonRecord(row.outputs_json, 'outputs_json', id),
		traceRefs: jsonRecord(row.trace_refs_json, 'trace_refs_json', id),
		usageActual: jsonRecord(row.usage_actual_json, 'usage_actual_json', id),
		validation: jsonRecord(row.validation_json, 'validation_json', id),
		fallbackReason: nullableText(row.fallback_reason),
		startedAt: nullableText(row.started_at),
		completedAt: nullableText(row.completed_at),
		failedAt: nullableText(row.failed_at),
		metadata: jsonRecord(row.metadata_json, 'metadata_json', id),
		createdAt: text(row.created_at),
		updatedAt: text(row.updated_at),
	};
	const validation = validateAgentModeRun(modeRun);
	if (!validation.ok) {
		const first = validation.diagnostics[0]!;
		throw new CapacityGovernanceError(first.code, `Mode run ${id || 'unknown'} is corrupt: ${first.message}`, 500, { modeRunId: id || null, path: first.path });
	}
	return modeRun as AgentModeRun;
}

export async function readAgentModeRun(
	database: CapacityGovernanceDatabase,
	teamId: string,
	modeRunId: string,
): Promise<AgentModeRun | null> {
	await database.ensureInitialized();
	return serializeAgentModeRunRow(await database.first(
		`SELECT * FROM agent_mode_runs WHERE id = ? AND team_id = ? LIMIT 1`,
		[modeRunId, teamId],
	));
}

export async function listAgentModeRunsPage(
	database: CapacityGovernanceDatabase,
	projectId: string,
	filters: AgentModeRunListFilters = {},
): Promise<CapacityPage<AgentModeRun>> {
	await database.ensureInitialized();
	const clauses = ['project_id = ?'];
	const values: unknown[] = [projectId];
	if (filters.mode) { clauses.push('mode = ?'); values.push(filters.mode); }
	if (filters.assignmentId) { clauses.push('provider_assignment_id = ?'); values.push(filters.assignmentId); }
	if (filters.workDayId) {
		clauses.push('provider_assignment_id IN (SELECT id FROM capacity_provider_assignments WHERE work_day_id = ?)');
		values.push(filters.workDayId);
	}
	if (filters.cursor) {
		clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
		values.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id);
	}
	const limit = normalizeCapacityPageLimit(filters.limit);
	const rows = await database.all<AgentModeRunRow>(
		`SELECT * FROM agent_mode_runs
		 WHERE ${clauses.join(' AND ')}
		 ORDER BY created_at DESC, id DESC LIMIT ?`,
		[...values, limit + 1],
	);
	const hasMore = rows.length > limit;
	const selected = rows.slice(0, limit);
	const last = selected.at(-1);
	return {
		items: selected.map((row) => serializeAgentModeRunRow(row)).filter((run): run is AgentModeRun => run !== null),
		page: {
			limit,
			hasMore,
			nextCursor: hasMore && last
				? encodeCapacityPageCursor({ createdAt: String(last.created_at), id: String(last.id) })
				: null,
		},
	};
}

export async function persistAgentModeRun(
	database: ModeRunRepositoryDatabase,
	input: AgentModeRunWrite,
): Promise<AgentModeRun | null> {
	await database.ensureInitialized();
	const assignment = await database.getProviderAssignment(input.teamId, input.providerAssignmentId);
	if (!assignment) return null;
	const now = new Date().toISOString();
	const id = input.id ?? randomUUID();
	const operations: CapacityDatabaseOperation[] = [{
		query: `INSERT INTO agent_mode_runs (
			id, team_id, project_id, provider_assignment_id, capacity_provider_id, execution_provider_id,
			project_agent_class_id, agent_id, handler_id, mode, status, selected_input_json, capacity_envelope_json,
			outputs_json, trace_refs_json, usage_actual_json, validation_json, fallback_reason,
			started_at, completed_at, failed_at, metadata_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			execution_provider_id = EXCLUDED.execution_provider_id,
			project_agent_class_id = EXCLUDED.project_agent_class_id,
			agent_id = EXCLUDED.agent_id,
			handler_id = EXCLUDED.handler_id,
			mode = EXCLUDED.mode,
			status = EXCLUDED.status,
			selected_input_json = EXCLUDED.selected_input_json,
			capacity_envelope_json = EXCLUDED.capacity_envelope_json,
			outputs_json = EXCLUDED.outputs_json,
			trace_refs_json = EXCLUDED.trace_refs_json,
			usage_actual_json = EXCLUDED.usage_actual_json,
			validation_json = EXCLUDED.validation_json,
			fallback_reason = EXCLUDED.fallback_reason,
			started_at = COALESCE(EXCLUDED.started_at, agent_mode_runs.started_at),
			completed_at = COALESCE(EXCLUDED.completed_at, agent_mode_runs.completed_at),
			failed_at = COALESCE(EXCLUDED.failed_at, agent_mode_runs.failed_at),
			metadata_json = EXCLUDED.metadata_json,
			updated_at = EXCLUDED.updated_at
		WHERE agent_mode_runs.team_id = EXCLUDED.team_id
		  AND agent_mode_runs.provider_assignment_id = EXCLUDED.provider_assignment_id`,
		params: [
			id,
			assignment.teamId,
			assignment.projectId,
			assignment.id,
			assignment.capacityProviderId,
			input.executionProviderId ?? assignment.executionProviderId ?? null,
			assignment.projectAgentClassId,
			input.agentId ?? assignment.agentId ?? null,
			input.handlerId ?? assignment.handlerId ?? null,
			input.mode ?? assignment.mode,
			input.status ?? 'queued',
			JSON.stringify(input.selectedInput ?? {}),
			JSON.stringify(input.capacityEnvelope ?? assignment.capacityEnvelope),
			JSON.stringify(input.outputs ?? {}),
			JSON.stringify(input.traceRefs ?? {}),
			JSON.stringify(input.usageActual ?? {}),
			JSON.stringify(input.validation ?? {}),
			input.fallbackReason ?? null,
			input.startedAt ?? null,
			input.completedAt ?? null,
			input.failedAt ?? null,
			JSON.stringify(input.metadata ?? {}),
			now,
			now,
		],
	}];
	const usageActualId = input.capacityUsageActualId ?? null;
	if (usageActualId) {
		operations.push({
			query: `UPDATE capacity_usage_actuals
			 SET assignment_id = ?, mode_run_id = ?, mode = ?
			 WHERE id = ?
			   AND EXISTS (
				SELECT 1 FROM agent_mode_runs
				 WHERE id = ? AND team_id = ? AND provider_assignment_id = ?
			   )`,
			params: [assignment.id, id, input.mode ?? assignment.mode, usageActualId, id, assignment.teamId, assignment.id],
		});
	}
	await database.batch(operations);
	const stored = await readAgentModeRun(database, assignment.teamId, id);
	if (!stored || stored.providerAssignmentId !== assignment.id) {
		throw new CapacityGovernanceError(
			'agent_mode_run_idempotency_conflict',
			'Mode-run id is already owned by a different provider assignment.',
			409,
			{ modeRunId: id, assignmentId: assignment.id },
		);
	}
	return stored;
}
