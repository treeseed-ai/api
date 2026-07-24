import type { CapacityAllocationSetV2 } from '@treeseed/sdk/agent-capacity/allocation';
import {
	encodeCapacityPageCursor,
	type CapacityPage,
	type CapacityPageCursor,
} from '@treeseed/sdk/capacity-pagination';
import { decodeDurableJsonArray, decodeDurableJsonObject } from '../../../durable-json.ts';
import type { CapacityDatabaseOperation, CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';

type Row = Record<string, unknown>;

const STATUSES = new Set<CapacityAllocationSetV2['status']>([
	'draft', 'validated', 'active', 'superseded', 'archived',
]);

function text(value: unknown): string {
	return value == null ? '' : String(value);
}

function nullableText(value: unknown): string | null {
	return value == null ? null : String(value);
}

function status(value: unknown, allocationSetId: string): CapacityAllocationSetV2['status'] {
	const candidate = text(value) as CapacityAllocationSetV2['status'];
	if (!STATUSES.has(candidate)) {
		throw new CapacityGovernanceError('capacity_allocation_status_invalid', `Allocation set ${allocationSetId} has invalid status ${candidate || '(empty)'}.`, 500, { allocationSetId });
	}
	return candidate;
}

function context(id: string, column: string) {
	return { owner: 'capacity allocation set', ownerId: id, column };
}

export function serializeCapacityAllocationSetRow(row: Row | null): CapacityAllocationSetV2 | null {
	if (!row) return null;
	const id = text(row.id);
	const version = Number(row.version);
	if (!id || !text(row.team_id) || !Number.isInteger(version) || version < 1) {
		throw new CapacityGovernanceError('capacity_allocation_record_invalid', `Allocation set ${id || '(unknown)'} has invalid durable identity fields.`, 500, { allocationSetId: id || null });
	}
	return {
		schemaVersion: 2,
		id,
		teamId: text(row.team_id),
		version,
		status: status(row.status, id),
		effectiveFrom: text(row.effective_from),
		effectiveUntil: nullableText(row.effective_until),
		reservePolicy: decodeDurableJsonObject(row.reserve_policy_json, context(id, 'reserve_policy_json')) as unknown as CapacityAllocationSetV2['reservePolicy'],
		slices: decodeDurableJsonArray<CapacityAllocationSetV2['slices'][number]>(row.slices_json, context(id, 'slices_json')),
		borrowingRules: decodeDurableJsonArray<CapacityAllocationSetV2['borrowingRules'][number]>(row.borrowing_rules_json, context(id, 'borrowing_rules_json')),
		metadata: decodeDurableJsonObject(row.metadata_json, context(id, 'metadata_json')),
		createdById: nullableText(row.created_by_id),
		activatedAt: nullableText(row.activated_at),
		supersededById: nullableText(row.superseded_by_id),
		createdAt: text(row.created_at),
		updatedAt: text(row.updated_at),
	};
}

export class CapacityAllocationSetRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async nextVersion(teamId: string): Promise<number> {
		await this.database.ensureInitialized();
		const row = await this.database.first(`SELECT COALESCE(MAX(version), 0) AS max_version FROM capacity_allocation_sets WHERE team_id = ?`, [teamId]);
		return Number(row?.max_version ?? 0) + 1;
	}

	async create(allocation: CapacityAllocationSetV2, operations: CapacityDatabaseOperation[] = []): Promise<CapacityAllocationSetV2> {
		await this.database.ensureInitialized();
		const now = allocation.updatedAt ?? new Date().toISOString();
		await this.database.batch([
			{
				query: `INSERT INTO capacity_allocation_sets (
					id, team_id, version, status, effective_from, effective_until, reserve_policy_json, slices_json,
					borrowing_rules_json, metadata_json, created_by_id, activated_at, superseded_by_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				params: [
				allocation.id, allocation.teamId, allocation.version, allocation.status, allocation.effectiveFrom,
				allocation.effectiveUntil ?? null, JSON.stringify(allocation.reservePolicy), JSON.stringify(allocation.slices),
				JSON.stringify(allocation.borrowingRules), JSON.stringify(allocation.metadata ?? {}),
				allocation.createdById ?? null, allocation.activatedAt ?? null, allocation.supersededById ?? null,
				allocation.createdAt ?? now, now,
				],
			},
			...operations,
		]);
		const serialized = await this.get(allocation.teamId, allocation.id);
		if (!serialized) throw new CapacityGovernanceError('capacity_allocation_persistence_failed', 'Capacity allocation set was not persisted.', 500, { allocationSetId: allocation.id });
		return serialized;
	}

	async get(teamId: string, allocationSetId: string): Promise<CapacityAllocationSetV2 | null> {
		await this.database.ensureInitialized();
		return serializeCapacityAllocationSetRow(await this.database.first(`SELECT * FROM capacity_allocation_sets WHERE id = ? AND team_id = ? LIMIT 1`, [allocationSetId, teamId]));
	}

	async getActive(teamId: string, at = new Date().toISOString()): Promise<CapacityAllocationSetV2 | null> {
		await this.database.ensureInitialized();
		return serializeCapacityAllocationSetRow(await this.database.first(
			`SELECT * FROM capacity_allocation_sets
			 WHERE team_id = ? AND status = 'active' AND effective_from <= ? AND (effective_until IS NULL OR effective_until > ?)
			 ORDER BY effective_from DESC, version DESC, created_at DESC LIMIT 1`, [teamId, at, at],
		));
	}

	async listPage(teamId: string, page: { limit: number; cursor: CapacityPageCursor | null }): Promise<CapacityPage<CapacityAllocationSetV2>> {
		await this.database.ensureInitialized();
		const clauses = ['team_id = ?'];
		const values: unknown[] = [teamId];
		if (page.cursor) {
			clauses.push('(created_at < ? OR (created_at = ? AND id > ?))');
			values.push(page.cursor.createdAt, page.cursor.createdAt, page.cursor.id);
		}
		values.push(page.limit + 1);
		const rows = await this.database.all(`SELECT * FROM capacity_allocation_sets WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id ASC LIMIT ?`, values);
		const hasMore = rows.length > page.limit;
		const pageRows = rows.slice(0, page.limit);
		const last = pageRows.at(-1);
		return {
			items: pageRows.map((row) => serializeCapacityAllocationSetRow(row) as CapacityAllocationSetV2),
			page: { limit: page.limit, hasMore, nextCursor: hasMore && last ? encodeCapacityPageCursor({ createdAt: text(last.created_at), id: text(last.id) }) : null },
		};
	}

	async activate(
		teamId: string,
		allocationSetId: string,
		expectedStatus: 'draft' | 'validated',
		operations: CapacityDatabaseOperation[] = [],
		now = new Date().toISOString(),
		expectedActiveAllocationSetId: string | null = null,
	): Promise<CapacityAllocationSetV2> {
		await this.database.ensureInitialized();
		const candidate = await this.get(teamId, allocationSetId);
		if (!candidate || candidate.status !== expectedStatus) throw new CapacityGovernanceError('capacity_allocation_activation_conflict', 'Capacity allocation activation lost a concurrent state transition.', 409, { allocationSetId, expectedStatus });
		const supersedeOverlap = expectedActiveAllocationSetId
			? {
				query: `UPDATE capacity_allocation_sets SET status = 'superseded', superseded_by_id = ?, updated_at = ? WHERE id = ? AND team_id = ? AND status = 'active'`,
				params: [allocationSetId, now, expectedActiveAllocationSetId, teamId],
			}
			: candidate.effectiveUntil
				? { query: `UPDATE capacity_allocation_sets SET status = 'superseded', superseded_by_id = ?, updated_at = ? WHERE team_id = ? AND status = 'active' AND id <> ? AND effective_from < ? AND (effective_until IS NULL OR ? < effective_until)`, params: [allocationSetId, now, teamId, allocationSetId, candidate.effectiveUntil, candidate.effectiveFrom] }
				: { query: `UPDATE capacity_allocation_sets SET status = 'superseded', superseded_by_id = ?, updated_at = ? WHERE team_id = ? AND status = 'active' AND id <> ? AND (effective_until IS NULL OR ? < effective_until)`, params: [allocationSetId, now, teamId, allocationSetId, candidate.effectiveFrom] };
		const activationGuard = expectedActiveAllocationSetId
			? ` AND EXISTS (SELECT 1 FROM capacity_allocation_sets WHERE id = ? AND team_id = ? AND status = 'superseded' AND superseded_by_id = ?)`
			: '';
		const activationParams = expectedActiveAllocationSetId
			? [now, now, allocationSetId, teamId, expectedStatus, expectedActiveAllocationSetId, teamId, allocationSetId]
			: [now, now, allocationSetId, teamId, expectedStatus];
		await this.database.batch([
			{ query: `SELECT id FROM teams WHERE id = ? FOR UPDATE`, params: [teamId] },
			supersedeOverlap,
			{ query: `UPDATE capacity_allocation_sets SET status = 'active', activated_at = COALESCE(activated_at, ?), superseded_by_id = NULL, updated_at = ? WHERE id = ? AND team_id = ? AND status = ?${activationGuard}`, params: activationParams },
			...operations,
		]);
		const activated = await this.get(teamId, allocationSetId);
		if (activated?.status !== 'active') {
			throw new CapacityGovernanceError('capacity_allocation_activation_conflict', 'Capacity allocation activation lost a concurrent state transition.', 409, { allocationSetId, expectedStatus });
		}
		return activated;
	}

	async archive(teamId: string, allocationSetId: string, operations: CapacityDatabaseOperation[] = [], now = new Date().toISOString()): Promise<CapacityAllocationSetV2> {
		await this.database.ensureInitialized();
		await this.database.batch([
			{ query: `UPDATE capacity_allocation_sets SET status = 'archived', updated_at = ? WHERE id = ? AND team_id = ? AND status IN ('draft', 'validated', 'superseded')`, params: [now, allocationSetId, teamId] },
			...operations,
		]);
		const archived = await this.get(teamId, allocationSetId);
		if (archived?.status !== 'archived') {
			throw new CapacityGovernanceError('capacity_allocation_archive_conflict', 'Capacity allocation archive lost a concurrent state transition.', 409, { allocationSetId });
		}
		return archived;
	}
}
