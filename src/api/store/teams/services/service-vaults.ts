import { randomUUID } from 'node:crypto';
import type { MarketControlPlaneStore } from '../../../persistence/store.ts';

export async function getUserVaultKeyMethod(this: MarketControlPlaneStore, userId: string) {
	await this.ensureInitialized();
	const row: any = await this.first(
		`SELECT * FROM user_vault_keys WHERE user_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1`,
		[userId],
	);
	if (!row) return null;
	return {
		id: row.id,
		userId: row.user_id,
		publicKey: row.public_key,
		encryptedPrivateKeyEnvelope: JSON.parse(row.encrypted_private_key_envelope_json),
		status: row.status,
		version: Number(row.version),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function upsertUserVaultKeyMethod(this: MarketControlPlaneStore, userId: string, input: any) {
	await this.ensureInitialized();
	const existing = await this.getUserVaultKey(userId);
	const now = new Date().toISOString();
	const id = input.id ?? randomUUID();
	if (existing) {
		await this.run(`UPDATE user_vault_keys SET status = 'retired', updated_at = ? WHERE user_id = ? AND status = 'active'`, [now, userId]);
	}
	const version = Number(existing?.version ?? 0) + 1;
	await this.run(
		`INSERT INTO user_vault_keys (
			id, user_id, public_key, encrypted_private_key_envelope_json, status, version, created_at, updated_at
		) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
		[id, userId, input.publicKey, JSON.stringify(input.encryptedPrivateKeyEnvelope), version, now, now],
	);
	await this.recordAuditEvent({
		eventType: existing ? 'vault.user_key.rotated' : 'vault.user_key.created',
		actorType: 'user',
		actorId: userId,
		targetType: 'user_vault_key',
		targetId: id,
		data: { version },
	});
	return this.getUserVaultKey(userId);
}

export async function getTeamVaultSummaryMethod(this: MarketControlPlaneStore, teamId: string, userId?: string) {
	await this.ensureInitialized();
	const vault: any = await this.first(`SELECT * FROM team_vaults WHERE team_id = ?`, [teamId]);
	if (!vault) return null;
	const grants: any[] = await this.all(
		`SELECT vault_grant.id, vault_grant.user_id, vault_grant.user_vault_key_id, vault_grant.key_version, vault_grant.status,
			vault_grant.granted_by_user_id, vault_grant.revoked_at, vault_grant.created_at, vault_grant.updated_at, vault_key.public_key
		 FROM team_vault_grants vault_grant
		 LEFT JOIN user_vault_keys vault_key ON vault_key.id = vault_grant.user_vault_key_id
		 WHERE vault_grant.team_id = ? ORDER BY vault_grant.created_at`,
		[teamId],
	);
	const ownGrant: any = userId
		? await this.first(`SELECT * FROM team_vault_grants WHERE team_id = ? AND user_id = ? AND status = 'active' ORDER BY key_version DESC LIMIT 1`, [teamId, userId])
		: null;
	return {
		teamId,
		status: vault.status,
		encryptionVersion: vault.encryption_version,
		activeKeyVersion: Number(vault.active_key_version),
		recoveryMode: vault.recovery_mode,
		createdByUserId: vault.created_by_user_id,
		createdAt: vault.created_at,
		updatedAt: vault.updated_at,
		grants: grants.map((grant) => ({
			id: grant.id,
			userId: grant.user_id,
			userVaultKeyId: grant.user_vault_key_id,
			publicKey: grant.public_key,
			keyVersion: Number(grant.key_version),
			status: grant.status,
			grantedByUserId: grant.granted_by_user_id,
			revokedAt: grant.revoked_at ?? null,
			createdAt: grant.created_at,
			updatedAt: grant.updated_at,
		})),
		ownGrant: ownGrant ? {
			id: ownGrant.id,
			userVaultKeyId: ownGrant.user_vault_key_id,
			keyVersion: Number(ownGrant.key_version),
			wrappedTeamVaultKey: ownGrant.wrapped_team_vault_key,
		} : null,
	};
}

export async function initializeTeamVaultMethod(this: MarketControlPlaneStore, teamId: string, input: any) {
	await this.ensureInitialized();
	if (await this.first(`SELECT team_id FROM team_vaults WHERE team_id = ?`, [teamId])) {
		throw new Error('The team service vault is already initialized.');
	}
	const now = new Date().toISOString();
	const grantId = randomUUID();
	await this.batch([
		{
			query: `INSERT INTO team_vaults (
				team_id, status, encryption_version, active_key_version, recovery_mode, created_by_user_id, created_at, updated_at
			) VALUES (?, 'active', ?, 1, 'administrator-regrant', ?, ?, ?)`,
			params: [teamId, input.encryptionVersion, input.actorUserId, now, now],
		},
		{
			query: `INSERT INTO team_vault_grants (
				id, team_id, user_id, user_vault_key_id, key_version, wrapped_team_vault_key,
				status, granted_by_user_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, 1, ?, 'active', ?, ?, ?)`,
			params: [grantId, teamId, input.actorUserId, input.userVaultKeyId, input.wrappedTeamVaultKey, input.actorUserId, now, now],
		},
	]);
	await this.recordAuditEvent({
		eventType: 'vault.team.initialized',
		actorType: 'user',
		actorId: input.actorUserId,
		targetType: 'team_vault',
		targetId: teamId,
		data: { teamId, keyVersion: 1 },
	});
	return this.getTeamVaultSummary(teamId, input.actorUserId);
}

export async function createTeamVaultGrantMethod(this: MarketControlPlaneStore, teamId: string, input: any) {
	await this.ensureInitialized();
	const vault: any = await this.first(`SELECT * FROM team_vaults WHERE team_id = ? AND status = 'active'`, [teamId]);
	if (!vault) throw new Error('The team service vault is not initialized.');
	const now = new Date().toISOString();
	await this.run(
		`UPDATE team_vault_grants SET status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ?
		 WHERE team_id = ? AND user_id = ? AND status = 'active'`,
		[input.actorUserId, now, now, teamId, input.userId],
	);
	const id = randomUUID();
	await this.run(
		`INSERT INTO team_vault_grants (
			id, team_id, user_id, user_vault_key_id, key_version, wrapped_team_vault_key,
			status, granted_by_user_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
		[id, teamId, input.userId, input.userVaultKeyId, vault.active_key_version, input.wrappedTeamVaultKey, input.actorUserId, now, now],
	);
	await this.recordAuditEvent({
		eventType: 'vault.access.granted',
		actorType: 'user',
		actorId: input.actorUserId,
		targetType: 'team_vault_grant',
		targetId: id,
		data: { teamId, userId: input.userId, keyVersion: Number(vault.active_key_version) },
	});
	return this.getTeamVaultSummary(teamId, input.userId);
}

export async function revokeTeamVaultGrantMethod(this: MarketControlPlaneStore, teamId: string, grantId: string, actorUserId: string) {
	await this.ensureInitialized();
	const now = new Date().toISOString();
	const grant: any = await this.first(`SELECT * FROM team_vault_grants WHERE team_id = ? AND id = ? AND status = 'active'`, [teamId, grantId]);
	if (!grant) return { ok: false, error: 'not_found' };
	const count: any = await this.first(`SELECT COUNT(*) AS count FROM team_vault_grants WHERE team_id = ? AND status = 'active'`, [teamId]);
	if (Number(count?.count ?? 0) <= 1) return { ok: false, error: 'last_grant' };
	await this.run(
		`UPDATE team_vault_grants SET status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ? WHERE id = ?`,
		[actorUserId, now, now, grantId],
	);
	await this.recordAuditEvent({
		eventType: 'vault.access.revoked',
		actorType: 'user',
		actorId: actorUserId,
		targetType: 'team_vault_grant',
		targetId: grantId,
		data: { teamId, userId: grant.user_id },
	});
	return { ok: true };
}

export async function upsertServiceCredentialEnvelopeMethod(this: MarketControlPlaneStore, teamId: string, input: any) {
	await this.ensureInitialized();
	const profile: any = await this.first(
		`SELECT * FROM team_service_credential_profiles WHERE team_id = ? AND connection_id = ? AND definition_id = ?`,
		[teamId, input.connectionId, input.definitionId],
	);
	const now = new Date().toISOString();
	let profileId = profile?.id;
	if (!profileId) {
		profileId = randomUUID();
		await this.run(
			`INSERT INTO team_service_credential_profiles (
				id, team_id, connection_id, definition_id, custody_mode, status, envelope_version, fingerprint, last_rotated_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, 'configured', ?, ?, ?, ?, ?)`,
			[profileId, teamId, input.connectionId, input.definitionId, input.custodyMode, input.envelope.version, input.envelope.fingerprint, now, now, now],
		);
	}
	const id = randomUUID();
	await this.run(
		`UPDATE credential_envelopes SET status = 'replaced', updated_at = ?
		 WHERE team_id = ? AND connection_id = ? AND credential_profile_id = ? AND field_key = ? AND status = 'active'`,
		[now, teamId, input.connectionId, profileId, input.fieldKey],
	);
	await this.run(
		`INSERT INTO credential_envelopes (
			id, team_id, connection_id, credential_profile_id, field_key, envelope_json, fingerprint, key_version, status, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
		[id, teamId, input.connectionId, profileId, input.fieldKey, JSON.stringify(input.envelope), input.envelope.fingerprint, input.keyVersion, now, now],
	);
	await this.recordAuditEvent({
		eventType: 'service.credential.updated',
		actorType: 'user',
		actorId: input.actorUserId,
		targetType: 'team_service_credential_profile',
		targetId: profileId,
		data: { teamId, connectionId: input.connectionId, definitionId: input.definitionId, fieldKey: input.fieldKey, fingerprint: input.envelope.fingerprint },
	});
	return { id, credentialProfileId: profileId, fingerprint: input.envelope.fingerprint, status: 'active' };
}

export async function listServiceCredentialEnvelopesMethod(this: MarketControlPlaneStore, teamId: string, connectionId: string) {
	await this.ensureInitialized();
	const rows: any[] = await this.all(
		`SELECT envelope.id, envelope.credential_profile_id, profile.definition_id, envelope.field_key, envelope.envelope_json,
			envelope.fingerprint, envelope.key_version, envelope.created_at, envelope.updated_at
		 FROM credential_envelopes envelope
		 JOIN team_service_credential_profiles profile ON profile.id = envelope.credential_profile_id
		 WHERE envelope.team_id = ? AND envelope.connection_id = ? AND envelope.status = 'active'
		 ORDER BY envelope.created_at`,
		[teamId, connectionId],
	);
	return rows.map((row) => ({
		id: row.id,
		credentialProfileId: row.credential_profile_id,
		definitionId: row.definition_id,
		fieldKey: row.field_key,
		envelope: JSON.parse(row.envelope_json),
		fingerprint: row.fingerprint,
		keyVersion: Number(row.key_version),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}));
}

export async function listTeamCredentialEnvelopesMethod(this: MarketControlPlaneStore, teamId: string) {
	await this.ensureInitialized();
	const rows: any[] = await this.all(
		`SELECT id, connection_id, credential_profile_id, field_key, envelope_json, fingerprint, key_version
		 FROM credential_envelopes WHERE team_id = ? AND status = 'active' ORDER BY id`,
		[teamId],
	);
	return rows.map((row) => ({
		id: row.id,
		connectionId: row.connection_id,
		credentialProfileId: row.credential_profile_id,
		fieldKey: row.field_key,
		envelope: JSON.parse(row.envelope_json),
		fingerprint: row.fingerprint,
		keyVersion: Number(row.key_version),
	}));
}

export async function rotateTeamVaultMethod(this: MarketControlPlaneStore, teamId: string, input: any) {
	await this.ensureInitialized();
	const vault: any = await this.first(`SELECT * FROM team_vaults WHERE team_id = ? AND status = 'active'`, [teamId]);
	if (!vault) throw new Error('The team service vault is not initialized.');
	if (Number(vault.active_key_version) !== Number(input.expectedKeyVersion)) {
		const error: any = new Error('The team vault changed after this rotation was prepared.');
		error.code = 'team_vault_conflict';
		throw error;
	}
	const keyVersion = Number(vault.active_key_version) + 1;
	const now = new Date().toISOString();
	const statements = [
		...input.envelopes.map((item: any) => ({
			query: `UPDATE credential_envelopes SET envelope_json = ?, key_version = ?, updated_at = ?
				WHERE team_id = ? AND id = ? AND status = 'active' AND key_version = ?`,
			params: [JSON.stringify(item.envelope), keyVersion, now, teamId, item.id, input.expectedKeyVersion],
		})),
		{
			query: `UPDATE team_vault_grants SET status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ?
				WHERE team_id = ? AND status = 'active'`,
			params: [input.actorUserId, now, now, teamId],
		},
		...input.grants.map((grant: any) => ({
			query: `INSERT INTO team_vault_grants (
				id, team_id, user_id, user_vault_key_id, key_version, wrapped_team_vault_key,
				status, granted_by_user_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
			params: [randomUUID(), teamId, grant.userId, grant.userVaultKeyId, keyVersion, grant.wrappedTeamVaultKey, input.actorUserId, now, now],
		})),
		{
			query: `UPDATE team_vaults SET active_key_version = ?, updated_at = ? WHERE team_id = ? AND active_key_version = ?`,
			params: [keyVersion, now, teamId, input.expectedKeyVersion],
		},
	];
	await this.batch(statements);
	await this.recordAuditEvent({
		eventType: 'vault.team.rotated',
		actorType: 'user',
		actorId: input.actorUserId,
		targetType: 'team_vault',
		targetId: teamId,
		data: { teamId, previousKeyVersion: input.expectedKeyVersion, keyVersion, credentialCount: input.envelopes.length, grantCount: input.grants.length },
	});
	return this.getTeamVaultSummary(teamId, input.actorUserId);
}

export async function resetTeamVaultMethod(this: MarketControlPlaneStore, teamId: string, input: any) {
	await this.ensureInitialized();
	const vault: any = await this.first(`SELECT * FROM team_vaults WHERE team_id = ?`, [teamId]);
	if (!vault) throw new Error('The team service vault is not initialized.');
	const now = new Date().toISOString();
	const keyVersion = Number(vault.active_key_version) + 1;
	const grantId = randomUUID();
	await this.batch([
		{ query: `DELETE FROM credential_envelopes WHERE team_id = ?`, params: [teamId] },
		{ query: `DELETE FROM team_service_credential_profiles WHERE team_id = ?`, params: [teamId] },
		{
			query: `UPDATE team_vault_grants
			 SET status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ?
			 WHERE team_id = ? AND status = 'active'`,
			params: [input.actorUserId, now, now, teamId],
		},
		{
			query: `UPDATE team_vaults
			 SET active_key_version = ?, encryption_version = ?, recovery_mode = 'administrator-regrant', updated_at = ?
			 WHERE team_id = ?`,
			params: [keyVersion, input.encryptionVersion, now, teamId],
		},
		{
			query: `INSERT INTO team_vault_grants (
				id, team_id, user_id, user_vault_key_id, key_version, wrapped_team_vault_key,
				status, granted_by_user_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
			params: [grantId, teamId, input.actorUserId, input.userVaultKeyId, keyVersion, input.wrappedTeamVaultKey, input.actorUserId, now, now],
		},
	]);
	await this.recordAuditEvent({
		eventType: 'vault.team.reset',
		actorType: 'user',
		actorId: input.actorUserId,
		targetType: 'team_vault',
		targetId: teamId,
		data: { teamId, keyVersion, credentialsDiscarded: true },
	});
	return this.getTeamVaultSummary(teamId, input.actorUserId);
}
