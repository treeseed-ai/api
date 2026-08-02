import { randomUUID } from 'node:crypto';
import type { MarketControlPlaneStore } from '../../../persistence/store.ts';

function serialize(row: any) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		connectionId: row.connection_id,
		provider: row.provider,
		reference: JSON.parse(row.reference_json),
		authMode: row.auth_mode,
		status: row.status,
		lastValidatedAt: row.last_validated_at ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function listExternalVaultBindingsMethod(
	this: MarketControlPlaneStore,
	teamId: string,
	connectionId: string,
) {
	await this.ensureInitialized();
	const rows = await this.all(
		`SELECT * FROM external_vault_bindings
		 WHERE team_id = ? AND connection_id = ? AND status <> 'removed'
		 ORDER BY updated_at DESC`,
		[teamId, connectionId],
	);
	return rows.map(serialize);
}

export async function createExternalVaultBindingMethod(
	this: MarketControlPlaneStore,
	teamId: string,
	connectionId: string,
	input: any,
) {
	await this.ensureInitialized();
	const id = randomUUID();
	const now = new Date().toISOString();
	await this.run(
		`INSERT INTO external_vault_bindings (
			id, team_id, connection_id, provider, reference_json, auth_mode,
			status, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, 'configured', ?, ?)`,
		[id, teamId, connectionId, input.provider, JSON.stringify(input.reference), input.authMode, now, now],
	);
	await this.recordAuditEvent({
		eventType: 'service.external_vault.configured',
		actorType: 'user',
		actorId: input.actorUserId,
		targetType: 'external_vault_binding',
		targetId: id,
		data: { teamId, connectionId, provider: input.provider, authMode: input.authMode },
	});
	return serialize(await this.first(`SELECT * FROM external_vault_bindings WHERE id = ?`, [id]));
}

export async function removeExternalVaultBindingMethod(
	this: MarketControlPlaneStore,
	teamId: string,
	bindingId: string,
	actorUserId: string,
) {
	await this.ensureInitialized();
	const row: any = await this.first(
		`SELECT * FROM external_vault_bindings WHERE team_id = ? AND id = ? AND status <> 'removed'`,
		[teamId, bindingId],
	);
	if (!row) return false;
	const now = new Date().toISOString();
	await this.run(
		`UPDATE external_vault_bindings SET status = 'removed', updated_at = ? WHERE id = ?`,
		[now, bindingId],
	);
	await this.recordAuditEvent({
		eventType: 'service.external_vault.removed',
		actorType: 'user',
		actorId: actorUserId,
		targetType: 'external_vault_binding',
		targetId: bindingId,
		data: { teamId, connectionId: row.connection_id, provider: row.provider },
	});
	return true;
}
