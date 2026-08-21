import { randomUUID } from 'node:crypto';
import type { ControlPlaneStore } from '../../../persistence/store.ts';

function json(value: unknown, fallback: unknown = {}) {
	if (value && typeof value === 'object') return value;
	try {
		return JSON.parse(String(value ?? ''));
	} catch {
		return fallback;
	}
}

function connection(row: any) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		providerId: row.provider_id,
		displayName: row.display_name,
		status: row.status,
		nonSecretConfig: json(row.non_secret_config_json),
		version: Number(row.version ?? 1),
		createdByUserId: row.created_by_user_id ?? null,
		updatedByUserId: row.updated_by_user_id ?? null,
		lastValidatedAt: row.last_validated_at ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function capability(row: any) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		connectionId: row.connection_id,
		capabilityType: row.capability_type,
		status: row.status,
		credentialProfileId: row.credential_profile_id ?? null,
		configuration: json(row.configuration_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function profile(row: any) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		connectionId: row.connection_id,
		definitionId: row.definition_id,
		custodyMode: row.custody_mode,
		status: row.status,
		envelopeVersion: row.envelope_version ?? null,
		fingerprint: row.fingerprint ?? null,
		lastRotatedAt: row.last_rotated_at ?? null,
		lastValidatedAt: row.last_validated_at ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function listTeamServiceConnectionsMethod(this: ControlPlaneStore, teamId: string) {
	await this.ensureInitialized();
	const rows = await this.all(
		`SELECT * FROM team_service_connections WHERE team_id = ? AND status <> 'disconnected' ORDER BY updated_at DESC`,
		[teamId],
	);
	return Promise.all(rows.map(async (row) => ({
		...connection(row),
		capabilities: (await this.all(
			`SELECT * FROM team_service_capability_bindings WHERE connection_id = ? ORDER BY capability_type`,
			[row.id],
		)).map(capability),
		credentialProfiles: (await this.all(
			`SELECT * FROM team_service_credential_profiles WHERE connection_id = ? ORDER BY definition_id`,
			[row.id],
		)).map(profile),
	})));
}

export async function getTeamServiceConnectionMethod(this: ControlPlaneStore, teamId: string, connectionId: string) {
	await this.ensureInitialized();
	const row = await this.first(`SELECT * FROM team_service_connections WHERE team_id = ? AND id = ? LIMIT 1`, [teamId, connectionId]);
	if (!row) return null;
	const [capabilities, credentialProfiles] = await Promise.all([
		this.all(`SELECT * FROM team_service_capability_bindings WHERE connection_id = ? ORDER BY capability_type`, [connectionId]),
		this.all(`SELECT * FROM team_service_credential_profiles WHERE connection_id = ? ORDER BY definition_id`, [connectionId]),
	]);
	return {
		...connection(row),
		capabilities: capabilities.map(capability),
		credentialProfiles: credentialProfiles.map(profile),
	};
}

export async function createTeamServiceConnectionMethod(this: ControlPlaneStore, teamId: string, input: any) {
	await this.ensureInitialized();
	const id = input.id ?? randomUUID();
	const now = new Date().toISOString();
	await this.run(
		`INSERT INTO team_service_connections (
			id, team_id, provider_id, display_name, status, non_secret_config_json, version,
			created_by_user_id, updated_by_user_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
		[id, teamId, input.providerId, input.displayName, input.status ?? 'active', JSON.stringify(input.nonSecretConfig ?? {}), input.actorUserId, input.actorUserId, now, now],
	);
	for (const item of input.capabilities ?? []) {
		await this.upsertTeamServiceCapability(teamId, id, item);
	}
	await this.recordAuditEvent({
		eventType: 'service.connection.created',
		actorType: 'user',
		actorId: input.actorUserId,
		targetType: 'team_service_connection',
		targetId: id,
		data: { teamId, providerId: input.providerId, capabilityTypes: (input.capabilities ?? []).map((item: any) => item.capabilityType) },
	});
	return this.getTeamServiceConnection(teamId, id);
}

export async function updateTeamServiceConnectionMethod(this: ControlPlaneStore, teamId: string, connectionId: string, input: any) {
	await this.ensureInitialized();
	const existing = await this.getTeamServiceConnection(teamId, connectionId);
	if (!existing) return null;
	if (input.version !== undefined && Number(input.version) !== existing.version) {
		const error: any = new Error('The service connection changed after this page was loaded.');
		error.code = 'service_connection_conflict';
		throw error;
	}
	const now = new Date().toISOString();
	await this.run(
		`UPDATE team_service_connections SET display_name = ?, non_secret_config_json = ?, status = ?,
			version = version + 1, updated_by_user_id = ?, updated_at = ? WHERE team_id = ? AND id = ?`,
		[
			input.displayName ?? existing.displayName,
			JSON.stringify(input.nonSecretConfig ?? existing.nonSecretConfig),
			input.status ?? existing.status,
			input.actorUserId,
			now,
			teamId,
			connectionId,
		],
	);
	if (Array.isArray(input.capabilities)) {
		await this.run(`UPDATE team_service_capability_bindings SET status = 'disabled', updated_at = ?
			WHERE team_id = ? AND connection_id = ?`, [now, teamId, connectionId]);
		for (const item of input.capabilities) await this.upsertTeamServiceCapability(teamId, connectionId, item);
	}
	await this.recordAuditEvent({
		eventType: 'service.connection.updated',
		actorType: 'user',
		actorId: input.actorUserId,
		targetType: 'team_service_connection',
		targetId: connectionId,
		data: { teamId, changedFields: ['displayName', 'nonSecretConfig', 'status', 'capabilities'] },
	});
	return this.getTeamServiceConnection(teamId, connectionId);
}

export async function upsertTeamServiceCapabilityMethod(
	this: ControlPlaneStore,
	teamId: string,
	connectionId: string,
	input: any,
) {
	await this.ensureInitialized();
	const existing = await this.first(
		`SELECT id FROM team_service_capability_bindings WHERE connection_id = ? AND capability_type = ?`,
		[connectionId, input.capabilityType],
	);
	const now = new Date().toISOString();
	if (existing) {
		await this.run(
			`UPDATE team_service_capability_bindings SET status = ?, credential_profile_id = ?, configuration_json = ?, updated_at = ? WHERE id = ?`,
			[input.status ?? 'configured', input.credentialProfileId ?? null, JSON.stringify(input.configuration ?? {}), now, existing.id],
		);
		return capability(await this.first(`SELECT * FROM team_service_capability_bindings WHERE id = ?`, [existing.id]));
	}
	const id = input.id ?? randomUUID();
	await this.run(
		`INSERT INTO team_service_capability_bindings (
			id, team_id, connection_id, capability_type, status, credential_profile_id, configuration_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[id, teamId, connectionId, input.capabilityType, input.status ?? 'configured', input.credentialProfileId ?? null, JSON.stringify(input.configuration ?? {}), now, now],
	);
	return capability(await this.first(`SELECT * FROM team_service_capability_bindings WHERE id = ?`, [id]));
}

export async function disconnectTeamServiceConnectionMethod(this: ControlPlaneStore, teamId: string, connectionId: string, actorUserId: string) {
	await this.ensureInitialized();
	const existing = await this.getTeamServiceConnection(teamId, connectionId);
	if (!existing) return { ok: false, error: 'not_found' };
	await this.batch([
		{ query: `DELETE FROM secret_operation_leases WHERE team_id = ? AND connection_id = ?`, params: [teamId, connectionId] },
		{ query: `DELETE FROM external_vault_bindings WHERE team_id = ? AND connection_id = ?`, params: [teamId, connectionId] },
		{ query: `DELETE FROM credential_envelopes WHERE team_id = ? AND connection_id = ?`, params: [teamId, connectionId] },
		{ query: `DELETE FROM team_service_credential_profiles WHERE team_id = ? AND connection_id = ?`, params: [teamId, connectionId] },
		{ query: `DELETE FROM team_service_capability_bindings WHERE team_id = ? AND connection_id = ?`, params: [teamId, connectionId] },
		{ query: `DELETE FROM team_service_connections WHERE team_id = ? AND id = ?`, params: [teamId, connectionId] },
	]);
	await this.recordAuditEvent({
		eventType: 'service.connection.disconnected',
		actorType: 'user',
		actorId: actorUserId,
		targetType: 'team_service_connection',
		targetId: connectionId,
		data: { teamId, providerId: existing.providerId },
	});
	return {
		ok: true,
		payload: {
			...existing,
			status: 'disconnected',
			capabilities: [],
			credentialProfiles: [],
		},
	};
}
