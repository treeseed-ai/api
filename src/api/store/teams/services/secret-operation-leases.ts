import { randomUUID } from 'node:crypto';
import type { ControlPlaneStore } from '../../../persistence/store.ts';

function lease(row: any) {
	if (!row) return null;
	const expired = ['awaiting-runner', 'pending', 'ready'].includes(row.status) && Date.parse(row.expires_at) <= Date.now();
	return {
		id: row.id,
		teamId: row.team_id,
		connectionId: row.connection_id,
		capabilityType: row.capability_type,
		purpose: row.purpose,
		resourceScope: JSON.parse(row.resource_scope_json),
		credentialProfileId: row.credential_profile_id,
		actorUserId: row.actor_user_id,
		requiredFields: JSON.parse(row.required_fields_json),
		publicKey: row.public_key,
		status: expired ? 'expired' : row.status,
		expiresAt: row.expires_at,
		consumedAt: row.consumed_at ?? null,
		operationCorrelationId: row.operation_correlation_id,
	};
}

export async function createSecretOperationLeaseMethod(this: ControlPlaneStore, teamId: string, input: any) {
	await this.ensureInitialized();
	const existing = await this.first(
		`SELECT * FROM secret_operation_leases WHERE team_id = ? AND idempotency_key = ?`,
		[teamId, input.idempotencyKey],
	);
	if (existing) return lease(existing);
	const id = randomUUID();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + Math.min(Math.max(Number(input.ttlSeconds ?? 120), 30), 300) * 1000).toISOString();
	await this.run(
		`INSERT INTO secret_operation_leases (
			id, team_id, connection_id, capability_type, purpose, resource_scope_json, credential_profile_id, actor_user_id, required_fields_json,
			public_key, status, operation_correlation_id, idempotency_key, expires_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'awaiting-runner', ?, ?, ?, ?, ?)`,
		[id, teamId, input.connectionId, input.capabilityType, input.purpose, JSON.stringify(input.resourceScope), input.credentialProfileId, input.actorUserId, JSON.stringify(input.requiredFields), input.operationCorrelationId, input.idempotencyKey, expiresAt, now.toISOString(), now.toISOString()],
	);
	await this.recordAuditEvent({
		eventType: 'service.operation.authorized',
		actorType: 'user',
		actorId: input.actorUserId,
		targetType: 'secret_operation_lease',
		targetId: id,
		data: { teamId, connectionId: input.connectionId, capabilityType: input.capabilityType, purpose: input.purpose, credentialProfileId: input.credentialProfileId, resourceScope: input.resourceScope, requiredFields: input.requiredFields, expiresAt },
	});
	return lease(await this.first(`SELECT * FROM secret_operation_leases WHERE id = ?`, [id]));
}

export async function listAwaitingSecretOperationLeasesMethod(this: ControlPlaneStore) {
	await this.ensureInitialized();
	const now = new Date().toISOString();
	return (await this.all(
		`SELECT * FROM secret_operation_leases
		 WHERE status = 'awaiting-runner' AND expires_at > ? ORDER BY created_at LIMIT 20`,
		[now],
	)).map(lease);
}

export async function registerSecretOperationLeaseKeyMethod(
	this: ControlPlaneStore,
	leaseId: string,
	publicKey: string,
) {
	await this.ensureInitialized();
	const now = new Date().toISOString();
	await this.run(
		`UPDATE secret_operation_leases SET public_key = ?, status = 'pending', updated_at = ?
		 WHERE id = ? AND status = 'awaiting-runner' AND expires_at > ?`,
		[publicKey, now, leaseId, now],
	);
	const row: any = await this.first(`SELECT * FROM secret_operation_leases WHERE id = ?`, [leaseId]);
	return row?.status === 'pending' && row?.public_key === publicKey ? lease(row) : null;
}

export async function getSecretOperationLeaseMethod(this: ControlPlaneStore, teamId: string, leaseId: string) {
	await this.ensureInitialized();
	return lease(await this.first(`SELECT * FROM secret_operation_leases WHERE team_id = ? AND id = ?`, [teamId, leaseId]));
}

export async function submitSecretOperationPayloadMethod(this: ControlPlaneStore, teamId: string, leaseId: string, actorUserId: string, sealedPayload: string) {
	await this.ensureInitialized();
	const current: any = await this.first(`SELECT * FROM secret_operation_leases WHERE team_id = ? AND id = ?`, [teamId, leaseId]);
	if (!current) return { ok: false, error: 'not_found' };
	if (current.actor_user_id !== actorUserId) return { ok: false, error: 'wrong_actor' };
	if (current.status !== 'pending') return { ok: false, error: 'already_used' };
	if (Date.parse(current.expires_at) <= Date.now()) {
		await this.run(`UPDATE secret_operation_leases SET status = 'expired', updated_at = ? WHERE id = ?`, [new Date().toISOString(), leaseId]);
		return { ok: false, error: 'expired' };
	}
	const now = new Date().toISOString();
	await this.run(
		`UPDATE secret_operation_leases SET sealed_payload = ?, status = 'ready', updated_at = ? WHERE id = ? AND status = 'pending'`,
		[sealedPayload, now, leaseId],
	);
	return { ok: true, payload: await this.getSecretOperationLease(teamId, leaseId) };
}

export async function consumeSecretOperationLeaseMethod(this: ControlPlaneStore, leaseId: string) {
	await this.ensureInitialized();
	const current: any = await this.first(`SELECT * FROM secret_operation_leases WHERE id = ?`, [leaseId]);
	if (!current || current.status !== 'ready' || Date.parse(current.expires_at) <= Date.now()) return null;
	const now = new Date().toISOString();
	await this.run(
		`UPDATE secret_operation_leases SET status = 'consumed', consumed_at = ?, updated_at = ? WHERE id = ? AND status = 'ready'`,
		[now, now, leaseId],
	);
	return {
		...lease(current),
		status: 'consumed',
		consumedAt: now,
		sealedPayload: current.sealed_payload,
	};
}

export async function cancelSecretOperationLeaseMethod(
	this: ControlPlaneStore,
	teamId: string,
	leaseId: string,
	actorUserId: string,
) {
	await this.ensureInitialized();
	const current: any = await this.first(
		`SELECT * FROM secret_operation_leases WHERE team_id = ? AND id = ?`,
		[teamId, leaseId],
	);
	if (!current) return { ok: false, error: 'not_found' };
	if (current.actor_user_id !== actorUserId) return { ok: false, error: 'wrong_actor' };
	if (!['pending', 'ready'].includes(current.status)) return { ok: false, error: 'terminal' };
	const now = new Date().toISOString();
	await this.run(
		`UPDATE secret_operation_leases
		 SET status = 'cancelled', sealed_payload = NULL, cancelled_at = ?, updated_at = ?
		 WHERE team_id = ? AND id = ? AND status IN ('pending', 'ready')`,
		[now, now, teamId, leaseId],
	);
	await this.recordAuditEvent({
		eventType: 'service.operation.cancelled',
		actorType: 'user',
		actorId: actorUserId,
		targetType: 'secret_operation_lease',
		targetId: leaseId,
		data: { teamId, connectionId: current.connection_id, capabilityType: current.capability_type },
	});
	return { ok: true };
}
