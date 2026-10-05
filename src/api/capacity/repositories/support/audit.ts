import {
decodeCapacityPageCursor,
encodeCapacityPageCursor,
normalizeCapacityPageLimit,
type CapacityPage,
} from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import type { ProviderRegistrationRequest } from '@treeseed/sdk/capacity-provider/contracts';
import { sha256 } from '../../security.ts';

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

	async recordRegistrationRequest(request: ProviderRegistrationRequest, idempotencyKey: string) {
		await this.recordOnce({ teamId: request.teamId, providerId: request.providerId,
			actorType: 'provider-identity', actorId: request.providerFingerprint, action: 'provider-registration.requested',
			resourceType: 'provider-registration-request', resourceId: request.id, requestId: request.id, idempotencyKey,
			metadata: { registrationKeyGeneration: request.registrationKeyGeneration }, now: request.createdAt });
	}

	async recordRegistrationReview(request: ProviderRegistrationRequest, idempotencyKey: string) {
		if (!['approved', 'rejected'].includes(request.status) || !request.reviewedAt || !request.reviewedById
			|| (request.status === 'approved' ? !request.membershipId : !request.rejectionReason)) throw new CapacityGovernanceError(
			'provider_registration_review_evidence_invalid', 'Review audit requires the original committed disposition, actor and clock.', 500);
		await this.recordOnce({ teamId: request.teamId, providerId: request.providerId, membershipId: request.status === 'approved' ? request.membershipId : null,
			actorType: 'team-principal', actorId: request.reviewedById, action: `provider-registration.${request.status}`, resourceType: 'provider-registration-request',
			resourceId: request.id, requestId: request.id, idempotencyKey,
			metadata: request.status === 'approved' ? { membershipOnly: true } : { reason: request.rejectionReason }, now: request.reviewedAt });
	}

	private async recordOnce(input: Omit<CapacityAuditWrite, 'id'>) {
		await this.record({ ...input, id: sha256(`${input.action}:${input.resourceId}`) }, true);
	}

	async record(input: CapacityAuditWrite, onlyAbsent = false): Promise<void> {
		await this.database.ensureInitialized();
		const values = onlyAbsent ? `SELECT incoming.* FROM (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
			AS incoming(id, team_id, capacity_provider_id, membership_id, actor_type, actor_id, action, resource_type, resource_id, request_id, idempotency_key, metadata_json, created_at)
			WHERE NOT EXISTS (SELECT 1 FROM capacity_audit_events existing WHERE existing.team_id IS NOT DISTINCT FROM incoming.team_id
				AND existing.action = incoming.action AND existing.resource_id IS NOT DISTINCT FROM incoming.resource_id)` : 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
		await this.database.run(
			`INSERT INTO capacity_audit_events (id, team_id, capacity_provider_id, membership_id, actor_type, actor_id, action, resource_type, resource_id, request_id, idempotency_key, metadata_json, created_at)
			 ${values} ON CONFLICT DO NOTHING`,
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
