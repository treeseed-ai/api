import type { CapacityWorkdayEventRecord, CapacityWorkdayEventStatus } from '@treeseed/sdk/agent-capacity';
import {
	encodeCapacityPageCursor,
	normalizeCapacityPageLimit,
	type CapacityPage,
	type CapacityPageCursor,
} from '@treeseed/sdk/capacity-pagination';
import { decodeDurableJsonObject } from '../../../durable-json.ts';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';

type Row = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;
const STATUSES = new Set<CapacityWorkdayEventStatus>(['recorded', 'active', 'completed', 'warning', 'error', 'failed']);

function required(row: Row, column: string): string {
	const value = row[column];
	if (typeof value !== 'string' || !value) throw new CapacityGovernanceError('capacity_workday_event_corrupt', `Capacity workday event has invalid ${column}.`, 500, { eventId: typeof row.id === 'string' ? row.id : null, column });
	return value;
}
function nullable(value: unknown): string | null { return value == null ? null : typeof value === 'string' && value ? value : null; }
function json(row: Row, column: string) { return decodeDurableJsonObject(row[column], { owner: 'capacity workday event', ownerId: String(row.id ?? ''), column }); }

export function parseCapacityWorkdayEventStatus(value: unknown, errorStatus = 400): CapacityWorkdayEventStatus {
	const candidate = String(value ?? '') as CapacityWorkdayEventStatus;
	if (!STATUSES.has(candidate)) throw new CapacityGovernanceError('capacity_workday_event_status_invalid', `Unknown capacity workday event status ${candidate || '(empty)'}.`, errorStatus, { status: candidate || null });
	return candidate;
}

export function serializeCapacityWorkdayEventRow(row: Row | null): CapacityWorkdayEventRecord | null {
	if (!row) return null;
	const eventIndex = Number(row.event_index);
	if (!Number.isInteger(eventIndex) || eventIndex < 0) throw new CapacityGovernanceError('capacity_workday_event_corrupt', 'Capacity workday event has an invalid event index.', 500, { eventId: String(row.id ?? ''), eventIndex: row.event_index });
	let status: CapacityWorkdayEventStatus;
	try { status = parseCapacityWorkdayEventStatus(required(row, 'status'), 500); }
	catch (error) {
		if (error instanceof CapacityGovernanceError) throw new CapacityGovernanceError('capacity_workday_event_corrupt', `Capacity workday event ${String(row.id)} has unknown status ${String(row.status)}.`, 500, { eventId: String(row.id), status: String(row.status) });
		throw error;
	}
	return {
		id: required(row, 'id'), runId: required(row, 'run_id'), teamId: required(row, 'team_id'),
		projectId: nullable(row.project_id), workdayId: nullable(row.workday_id), assignmentId: nullable(row.assignment_id), modeRunId: nullable(row.mode_run_id),
		eventIndex, eventType: required(row, 'event_type'), status, title: nullable(row.title), message: nullable(row.message),
		parameters: json(row, 'parameters_json'), context: json(row, 'context_json'), refs: json(row, 'refs_json'), metadata: json(row, 'metadata_json'),
		createdAt: required(row, 'created_at'),
	};
}

export interface CapacityWorkdayEventWrite {
	id: string; projectId: string | null; workdayId: string | null; assignmentId: string | null; modeRunId: string | null;
	eventType: string; status: CapacityWorkdayEventStatus; title: string | null; message: string | null;
	parameters: JsonRecord; context: JsonRecord; refs: JsonRecord; metadata: JsonRecord; createdAt: string;
}

export class CapacityWorkdayEventRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async create(teamId: string, runId: string, value: CapacityWorkdayEventWrite) {
		await this.database.ensureInitialized();
		await this.database.batch([
			{ query: `UPDATE capacity_workday_runs SET next_event_index = next_event_index + 1 WHERE id = ? AND team_id = ? AND NOT EXISTS (SELECT 1 FROM capacity_workday_events WHERE id = ?)`, params: [runId, teamId, value.id] },
			{ query: `INSERT INTO capacity_workday_events (id, run_id, team_id, project_id, workday_id, assignment_id, mode_run_id, event_index, event_type, status, title, message, parameters_json, context_json, refs_json, metadata_json, created_at)
				SELECT ?, id, team_id, ?, ?, ?, ?, next_event_index - 1, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM capacity_workday_runs
				WHERE id = ? AND team_id = ? AND NOT EXISTS (SELECT 1 FROM capacity_workday_events WHERE id = ?)`,
				params: [value.id, value.projectId, value.workdayId, value.assignmentId, value.modeRunId, value.eventType, value.status, value.title, value.message, JSON.stringify(value.parameters), JSON.stringify(value.context), JSON.stringify(value.refs), JSON.stringify(value.metadata), value.createdAt, runId, teamId, value.id] },
		]);
		return this.get(teamId, runId, value.id);
	}

	async get(teamId: string, runId: string, eventId: string) {
		await this.database.ensureInitialized();
		return serializeCapacityWorkdayEventRow(await this.database.first(`SELECT * FROM capacity_workday_events WHERE id = ? AND run_id = ? AND team_id = ? LIMIT 1`, [eventId, runId, teamId]));
	}

	async list(teamId: string, runId: string, filters: { limit?: unknown; cursor?: CapacityPageCursor | null } = {}): Promise<CapacityPage<CapacityWorkdayEventRecord>> {
		await this.database.ensureInitialized();
		const clauses = ['team_id = ?', 'run_id = ?']; const values: unknown[] = [teamId, runId];
		if (filters.cursor) { clauses.push('(created_at > ? OR (created_at = ? AND id > ?))'); values.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id); }
		const limit = normalizeCapacityPageLimit(filters.limit);
		const rows = await this.database.all(`SELECT * FROM capacity_workday_events WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC, id ASC LIMIT ?`, [...values, limit + 1]);
		const selected = rows.slice(0, limit); const last = selected.at(-1); const hasMore = rows.length > limit;
		return { items: selected.map((row) => serializeCapacityWorkdayEventRow(row)!), page: { limit, hasMore, nextCursor: hasMore && last ? encodeCapacityPageCursor({ createdAt: String(last.created_at), id: String(last.id) }) : null } };
	}
}
