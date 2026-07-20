import type { CapacityReservation, CapacityReservationState } from '@treeseed/sdk/agent-capacity';
import {
	encodeCapacityPageCursor,
	normalizeCapacityPageLimit,
	type CapacityPage,
	type CapacityPageCursor,
} from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';

type Row = Record<string, unknown>;

const STATES = new Set<CapacityReservationState>([
	'reserved', 'consuming', 'consumed', 'released', 'expired', 'failed',
	'overran_pending_approval', 'continuation_required',
]);

export interface CapacityReservationPageFilters {
	workDayId?: string | null;
	states?: unknown;
	cursor?: CapacityPageCursor | null;
	limit?: unknown;
}

function corrupt(row: Row, column: string): never {
	throw new CapacityGovernanceError('capacity_reservation_corrupt', `Capacity reservation has invalid ${column}.`, 500, {
		reservationId: typeof row.id === 'string' ? row.id : null,
		column,
	});
}

function requiredText(row: Row, column: string): string {
	const value = row[column];
	return typeof value === 'string' && value ? value : corrupt(row, column);
}

function nullableText(row: Row, column: string): string | null {
	const value = row[column];
	return value == null ? null : typeof value === 'string' && value ? value : corrupt(row, column);
}

function number(row: Row, column: string, nullable = false): number | null {
	if (nullable && row[column] == null) return null;
	const value = Number(row[column]);
	return Number.isFinite(value) && value >= 0 ? value : corrupt(row, column);
}

function object(row: Row, column: string): Record<string, unknown> {
	const value = json(row, column);
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : corrupt(row, column);
}

function strings(row: Row, column: string): string[] {
	const value = json(row, column);
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry) ? value : corrupt(row, column);
}

function json(row: Row, column: string): unknown {
	const encoded = row[column];
	if (typeof encoded !== 'string') return encoded;
	try { return JSON.parse(encoded); } catch { return corrupt(row, column); }
}

function state(row: Row): CapacityReservationState {
	const value = requiredText(row, 'state') as CapacityReservationState;
	return STATES.has(value) ? value : corrupt(row, 'state');
}

export function serializeCapacityReservationRow(row: Row | null): CapacityReservation | null {
	if (!row) return null;
	const mode = requiredText(row, 'mode');
	if (mode !== 'planning' && mode !== 'acting') corrupt(row, 'mode');
	const allocationVersion = number(row, 'allocation_version');
	if (!Number.isInteger(allocationVersion) || allocationVersion! < 1) corrupt(row, 'allocation_version');
	return {
		id: requiredText(row, 'id'), idempotencyKey: requiredText(row, 'idempotency_key'), membershipId: requiredText(row, 'membership_id'),
		grantId: requiredText(row, 'grant_id'), capacityProviderId: requiredText(row, 'capacity_provider_id'),
		executionProviderId: nullableText(row, 'execution_provider_id'), laneId: nullableText(row, 'lane_id'),
		allocationSetId: requiredText(row, 'allocation_set_id'), allocationVersion: allocationVersion!, allocationSliceIds: strings(row, 'allocation_slice_ids_json'),
		policySnapshot: object(row, 'policy_snapshot_json'), projectAgentClassId: requiredText(row, 'project_agent_class_id'),
		assignmentId: nullableText(row, 'assignment_id'), mode, teamId: requiredText(row, 'team_id'), projectId: requiredText(row, 'project_id'),
		workDayId: nullableText(row, 'work_day_id'), taskId: nullableText(row, 'task_id'), state: state(row),
		reservedCredits: number(row, 'reserved_credits')!, consumedCredits: number(row, 'consumed_credits')!, nativeUnit: nullableText(row, 'native_unit'),
		reservedNativeAmount: number(row, 'reserved_native_amount', true), consumedNativeAmount: number(row, 'consumed_native_amount', true),
		reservedProviderUnits: number(row, 'reserved_provider_units', true), consumedProviderUnits: number(row, 'consumed_provider_units', true),
		reservedUsd: number(row, 'reserved_usd', true), consumedUsd: number(row, 'consumed_usd', true), expiresAt: nullableText(row, 'expires_at'),
		metadata: object(row, 'metadata_json'), createdAt: requiredText(row, 'created_at'), updatedAt: requiredText(row, 'updated_at'),
	};
}

export class CapacityReservationRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async listProjectPage(projectId: string, filters: CapacityReservationPageFilters = {}): Promise<CapacityPage<CapacityReservation>> {
		await this.database.ensureInitialized();
		const clauses = ['project_id = ?'];
		const values: unknown[] = [projectId];
		if (filters.workDayId) { clauses.push('work_day_id = ?'); values.push(filters.workDayId); }
		const states = Array.isArray(filters.states) ? [...new Set(filters.states.map(String))] : [];
		if (states.some((value) => !STATES.has(value as CapacityReservationState))) {
			throw new CapacityGovernanceError('capacity_reservation_state_invalid', 'Unknown capacity reservation state filter.', 400, { states });
		}
		if (states.length) { clauses.push(`state IN (${states.map(() => '?').join(', ')})`); values.push(...states); }
		if (filters.cursor) {
			clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
			values.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id);
		}
		const limit = normalizeCapacityPageLimit(filters.limit);
		const rows = await this.database.all(`SELECT * FROM capacity_reservations WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, [...values, limit + 1]);
		const selected = rows.slice(0, limit);
		const hasMore = rows.length > limit;
		const last = selected.at(-1);
		return { items: selected.map((row) => serializeCapacityReservationRow(row)!), page: { limit, hasMore, nextCursor: hasMore && last ? encodeCapacityPageCursor({ createdAt: requiredText(last, 'created_at'), id: requiredText(last, 'id') }) : null } };
	}
}
