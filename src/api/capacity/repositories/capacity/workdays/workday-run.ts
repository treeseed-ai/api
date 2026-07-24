import {
	encodeCapacityPageCursor,
	MAX_CAPACITY_PAGE_LIMIT,
	normalizeCapacityPageLimit,
	type CapacityPage,
	type CapacityPageCursor,
} from '@treeseed/sdk/capacity-pagination';
import type { CapacityWorkdayRunRecord, CapacityWorkdayRunStatus } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';

type JsonRecord = Record<string, unknown>;
export type DurableCapacityWorkdayRun = CapacityWorkdayRunRecord;

const STATUSES = new Set<CapacityWorkdayRunStatus>(['queued', 'running', 'completed', 'cancelled', 'failed', 'degraded']);

export function parseCapacityWorkdayRunStatus(value: unknown, errorStatus = 400): CapacityWorkdayRunStatus {
	const candidate = String(value ?? '') as CapacityWorkdayRunStatus;
	if (!STATUSES.has(candidate)) {
		throw new CapacityGovernanceError('capacity_workday_run_status_invalid', `Unknown capacity workday run status ${candidate || '(empty)'}.`, errorStatus, { status: candidate || null });
	}
	return candidate;
}

function requiredText(row: Record<string, unknown>, column: string): string {
	const value = row[column];
	if (typeof value !== 'string' || !value) {
		throw new CapacityGovernanceError('capacity_workday_run_corrupt', `Capacity workday run has invalid ${column}.`, 500, { column });
	}
	return value;
}

function nullableText(value: unknown): string | null {
	return typeof value === 'string' && value ? value : null;
}

function jsonObject(row: Record<string, unknown>, column: string): JsonRecord {
	let decoded: unknown;
	try {
		decoded = JSON.parse(requiredText(row, column));
	} catch (error) {
		if (error instanceof CapacityGovernanceError) throw error;
		throw new CapacityGovernanceError(
			'capacity_workday_run_corrupt',
			`Capacity workday run ${String(row.id)} contains invalid ${column}.`,
			500,
			{ runId: String(row.id), column },
		);
	}
	if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
		throw new CapacityGovernanceError(
			'capacity_workday_run_corrupt',
			`Capacity workday run ${String(row.id)} ${column} must be an object.`,
			500,
			{ runId: String(row.id), column },
		);
	}
	return decoded as JsonRecord;
}

export function serializeCapacityWorkdayRunRow(row: Record<string, unknown> | null): DurableCapacityWorkdayRun | null {
	if (!row) return null;
	let status: CapacityWorkdayRunStatus;
	try { status = parseCapacityWorkdayRunStatus(requiredText(row, 'status'), 500); }
	catch (error) {
		if (error instanceof CapacityGovernanceError) throw new CapacityGovernanceError('capacity_workday_run_corrupt', `Capacity workday run ${String(row.id)} has unknown status ${String(row.status)}.`, 500, { runId: String(row.id), status: String(row.status) });
		throw error;
	}
	return {
		id: requiredText(row, 'id'),
		teamId: requiredText(row, 'team_id'),
		capacityProviderId: nullableText(row.capacity_provider_id),
		scenarioId: requiredText(row, 'scenario_id'),
		status,
		environment: requiredText(row, 'environment'),
		requestedById: nullableText(row.requested_by_id),
		parameters: jsonObject(row, 'parameters_json'),
		summary: jsonObject(row, 'summary_json'),
		metrics: jsonObject(row, 'metrics_json'),
		expected: jsonObject(row, 'expected_json'),
		actual: jsonObject(row, 'actual_json'),
		reportRefs: jsonObject(row, 'report_refs_json'),
		error: jsonObject(row, 'error_json'),
		startedAt: nullableText(row.started_at),
		completedAt: nullableText(row.completed_at),
		createdAt: requiredText(row, 'created_at'),
		updatedAt: requiredText(row, 'updated_at'),
	};
}

export class CapacityWorkdayRunRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async get(teamId: string, runId: string): Promise<DurableCapacityWorkdayRun | null> {
		await this.database.ensureInitialized();
		return serializeCapacityWorkdayRunRow(await this.database.first(
			`SELECT * FROM capacity_workday_runs WHERE id = ? AND team_id = ? LIMIT 1`,
			[runId, teamId],
		));
	}

	async listActiveForProvider(
		teamId: string,
		providerId: string,
		limit = MAX_CAPACITY_PAGE_LIMIT,
	): Promise<DurableCapacityWorkdayRun[]> {
		await this.database.ensureInitialized();
		const boundedLimit = normalizeCapacityPageLimit(limit);
		const rows = await this.database.all(
			`SELECT * FROM capacity_workday_runs
			 WHERE team_id = ? AND capacity_provider_id = ? AND status = 'running'
			 ORDER BY started_at ASC, created_at ASC LIMIT ?`,
			[teamId, providerId, boundedLimit + 1],
		);
		if (rows.length > boundedLimit) {
			throw new CapacityGovernanceError(
				'capacity_active_workday_bound_exceeded',
				`Provider ${providerId} has more than ${boundedLimit} active workday runs.`,
				409,
				{ teamId, providerId, limit: boundedLimit },
			);
		}
		return rows.map((row) => serializeCapacityWorkdayRunRow(row)!);
	}

	async list(teamId: string, filters: {
		status?: string | null;
		providerId?: string | null;
		limit?: unknown;
		cursor?: CapacityPageCursor | null;
	} = {}): Promise<CapacityPage<DurableCapacityWorkdayRun>> {
		await this.database.ensureInitialized();
		const clauses = ['team_id = ?'];
		const values: unknown[] = [teamId];
		if (filters.status) { clauses.push('status = ?'); values.push(parseCapacityWorkdayRunStatus(filters.status)); }
		if (filters.providerId) { clauses.push('capacity_provider_id = ?'); values.push(filters.providerId); }
		if (filters.cursor) {
			clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
			values.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id);
		}
		const limit = normalizeCapacityPageLimit(filters.limit);
		const rows = await this.database.all(
			`SELECT * FROM capacity_workday_runs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
			[...values, limit + 1],
		);
		const selected = rows.slice(0, limit);
		const last = selected.at(-1);
		return {
			items: selected.map((row) => serializeCapacityWorkdayRunRow(row)!),
			page: {
				limit,
				hasMore: rows.length > limit,
				nextCursor: rows.length > limit && last
					? encodeCapacityPageCursor({ createdAt: String(last.created_at), id: String(last.id) })
					: null,
			},
		};
	}
}
