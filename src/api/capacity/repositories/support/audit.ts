import {
	decodeCapacityPageCursor,
	encodeCapacityPageCursor,
	normalizeCapacityPageLimit,
	type CapacityPage,
} from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';

export interface CapacityAuditEvent {
	id: string;
	teamId: string | null;
	capacityProviderId: string | null;
	membershipId: string | null;
	actorType: string;
	actorId: string | null;
	action: string;
	resourceType: string;
	resourceId: string | null;
	requestId: string | null;
	idempotencyKey: string | null;
	metadata: Record<string, unknown>;
	createdAt: string;
}

export interface CapacityAuditWrite {
	id: string;
	teamId?: string | null;
	providerId?: string | null;
	membershipId?: string | null;
	actorType: string;
	actorId?: string | null;
	action: string;
	resourceType: string;
	resourceId?: string | null;
	requestId?: string | null;
	idempotencyKey?: string | null;
	metadata?: Record<string, unknown>;
	now: string;
}

function auditEvent(row: Record<string, unknown>): CapacityAuditEvent {
	let metadata: unknown;
	try {
		metadata = JSON.parse(String(row.metadata_json));
	} catch {
		throw new CapacityGovernanceError(
			'capacity_audit_event_metadata_invalid',
			`Capacity audit event ${String(row.id)} contains invalid metadata.`,
			500,
			{ auditEventId: String(row.id) },
		);
	}
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
		throw new CapacityGovernanceError(
			'capacity_audit_event_metadata_invalid',
			`Capacity audit event ${String(row.id)} metadata must be an object.`,
			500,
			{ auditEventId: String(row.id) },
		);
	}
	return {
		id: String(row.id),
		teamId: row.team_id ? String(row.team_id) : null,
		capacityProviderId: row.capacity_provider_id ? String(row.capacity_provider_id) : null,
		membershipId: row.membership_id ? String(row.membership_id) : null,
		actorType: String(row.actor_type),
		actorId: row.actor_id ? String(row.actor_id) : null,
		action: String(row.action),
		resourceType: String(row.resource_type),
		resourceId: row.resource_id ? String(row.resource_id) : null,
		requestId: row.request_id ? String(row.request_id) : null,
		idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
		metadata: metadata as Record<string, unknown>,
		createdAt: String(row.created_at),
	};
}

export class CapacityAuditRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async record(input: CapacityAuditWrite): Promise<void> {
		await this.database.ensureInitialized();
		await this.database.run(
			`INSERT INTO capacity_audit_events (id, team_id, capacity_provider_id, membership_id, actor_type, actor_id, action, resource_type, resource_id, request_id, idempotency_key, metadata_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
			[
				input.id, input.teamId ?? null, input.providerId ?? null, input.membershipId ?? null,
				input.actorType, input.actorId ?? null, input.action, input.resourceType,
				input.resourceId ?? null, input.requestId ?? null, input.idempotencyKey ?? null,
				JSON.stringify(input.metadata ?? {}), input.now,
			],
		);
	}

	async listPage(teamId: string, input: {
		providerId?: unknown;
		membershipId?: unknown;
		action?: unknown;
		resourceType?: unknown;
		resourceId?: unknown;
		limit?: unknown;
		cursor?: unknown;
	} = {}): Promise<CapacityPage<CapacityAuditEvent>> {
		await this.database.ensureInitialized();
		let limit: number;
		let cursor;
		try {
			limit = normalizeCapacityPageLimit(input.limit);
			cursor = decodeCapacityPageCursor(input.cursor);
		} catch (error) {
			throw new CapacityGovernanceError('capacity_page_invalid', error instanceof Error ? error.message : String(error), 400);
		}
		const clauses = ['team_id = ?'];
		const values: unknown[] = [teamId];
		for (const [column, value] of [
			['capacity_provider_id', input.providerId], ['membership_id', input.membershipId],
			['action', input.action], ['resource_type', input.resourceType], ['resource_id', input.resourceId],
		] as const) {
			if (typeof value === 'string' && value.trim()) {
				clauses.push(`${column} = ?`);
				values.push(value.trim());
			}
		}
		if (cursor) {
			clauses.push('(created_at < ? OR (created_at = ? AND id > ?))');
			values.push(cursor.createdAt, cursor.createdAt, cursor.id);
		}
		const rows = await this.database.all(
			`SELECT * FROM capacity_audit_events WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id ASC LIMIT ?`,
			[...values, limit + 1],
		);
		const selected = rows.slice(0, limit);
		const last = selected.at(-1);
		return {
			items: selected.map(auditEvent),
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
