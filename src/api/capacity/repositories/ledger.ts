import type { CapacityLedgerEntry, CapacityLedgerPhase } from '@treeseed/sdk/agent-capacity';
import { encodeCapacityPageCursor, normalizeCapacityPageLimit, type CapacityPage, type CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';

type Row = Record<string, unknown>;
const PHASES = new Set<CapacityLedgerPhase>(['task_completed_actual_settlement', 'reservation_released', 'task_failed_refund', 'overrun_hold']);

export interface CapacityLedgerPageFilters {
	workDayId?: string | null;
	assignmentIds?: unknown;
	phases?: unknown;
	cursor?: CapacityPageCursor | null;
	limit?: unknown;
}

function corrupt(row: Row, column: string): never {
	throw new CapacityGovernanceError('capacity_ledger_entry_corrupt', `Capacity ledger entry has invalid ${column}.`, 500, {
		ledgerEntryId: typeof row.id === 'string' ? row.id : null, column,
	});
}
function requiredText(row: Row, column: string): string { const value = row[column]; return typeof value === 'string' && value ? value : corrupt(row, column); }
function nullableText(row: Row, column: string): string | null { const value = row[column]; return value == null ? null : typeof value === 'string' && value ? value : corrupt(row, column); }
function number(row: Row, column: string, nullable = false): number | null {
	if (nullable && row[column] == null) return null;
	const value = Number(row[column]);
	return Number.isFinite(value) && value >= 0 ? value : corrupt(row, column);
}
function object(row: Row, column: string): Record<string, unknown> {
	const encoded = row[column];
	let value: unknown = encoded;
	if (typeof encoded === 'string') { try { value = JSON.parse(encoded); } catch { return corrupt(row, column); } }
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : corrupt(row, column);
}

export function serializeCapacityLedgerEntryRow(row: Row | null): CapacityLedgerEntry | null {
	if (!row) return null;
	const phase = requiredText(row, 'phase') as CapacityLedgerPhase;
	if (!PHASES.has(phase)) corrupt(row, 'phase');
	const mode = nullableText(row, 'mode');
	if (mode !== null && mode !== 'planning' && mode !== 'acting') corrupt(row, 'mode');
	return {
		id: requiredText(row, 'id'), settlementKey: requiredText(row, 'settlement_key'), membershipId: requiredText(row, 'membership_id'),
		capacityProviderId: requiredText(row, 'capacity_provider_id'), reservationId: nullableText(row, 'reservation_id'), assignmentId: nullableText(row, 'assignment_id'),
		modeRunId: nullableText(row, 'mode_run_id'), mode: mode as 'planning' | 'acting' | null, teamId: requiredText(row, 'team_id'), projectId: nullableText(row, 'project_id'),
		workDayId: nullableText(row, 'work_day_id'), taskId: nullableText(row, 'task_id'), phase, credits: number(row, 'credits')!,
		providerUnits: number(row, 'provider_units', true), usd: number(row, 'usd', true), source: requiredText(row, 'source'),
		metadata: object(row, 'metadata_json'), createdAt: requiredText(row, 'created_at'),
	};
}

export class CapacityLedgerRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async listProjectPage(projectId: string, filters: CapacityLedgerPageFilters = {}): Promise<CapacityPage<CapacityLedgerEntry>> {
		await this.database.ensureInitialized();
		const clauses = ['project_id = ?'];
		const values: unknown[] = [projectId];
		if (filters.workDayId) { clauses.push('work_day_id = ?'); values.push(filters.workDayId); }
		const assignmentIds = Array.isArray(filters.assignmentIds) ? [...new Set(filters.assignmentIds.map(String).filter(Boolean))] : [];
		if (assignmentIds.length) { clauses.push(`assignment_id IN (${assignmentIds.map(() => '?').join(', ')})`); values.push(...assignmentIds); }
		const phases = Array.isArray(filters.phases) ? [...new Set(filters.phases.map(String))] : [];
		if (phases.some((value) => !PHASES.has(value as CapacityLedgerPhase))) throw new CapacityGovernanceError('capacity_ledger_phase_invalid', 'Unknown capacity ledger phase filter.', 400, { phases });
		if (phases.length) { clauses.push(`phase IN (${phases.map(() => '?').join(', ')})`); values.push(...phases); }
		if (filters.cursor) { clauses.push('(created_at < ? OR (created_at = ? AND id < ?))'); values.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id); }
		const limit = normalizeCapacityPageLimit(filters.limit);
		const rows = await this.database.all(`SELECT * FROM capacity_ledger_entries WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, [...values, limit + 1]);
		const selected = rows.slice(0, limit);
		const hasMore = rows.length > limit;
		const last = selected.at(-1);
		return { items: selected.map((row) => serializeCapacityLedgerEntryRow(row)!), page: { limit, hasMore, nextCursor: hasMore && last ? encodeCapacityPageCursor({ createdAt: requiredText(last, 'created_at'), id: requiredText(last, 'id') }) : null } };
	}
}
