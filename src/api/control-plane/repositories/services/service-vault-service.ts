import { randomUUID } from 'node:crypto';
import {
	SERVICE_VAULT_ENCRYPTION_VERSION,
	SECRET_OPERATION_PURPOSES,
	containsForbiddenPlaintextSecretMaterial,
	getServiceProviderDefinition,
	validateEncryptedCredentialEnvelope,
	validateHostedSecretOperationBinding,
} from '@treeseed/sdk/secrets-capability';
import { ServiceOperationError } from '../service-operation-error.ts';
import { verifyControlPlanePassword } from '../../../auth/password.ts';

type Principal = { id: string; roles?: string[]; permissions?: string[] } | undefined;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/u;

function json(value: unknown, fallback: unknown = {}) {
	try { return JSON.parse(String(value ?? '')); } catch { return fallback; }
}

function admin(principal: Principal) {
	return Boolean(principal?.roles?.some((role) => role === 'admin' || role === 'platform_admin')
		|| principal?.permissions?.includes('*:*:*'));
}

async function authorize(store: any, principal: Principal, teamId: string, ownerOnly = false) {
	if (!principal) throw new ServiceOperationError(401, 'authentication_required', 'Authentication is required.');
	if (admin(principal)) return principal;
	const context = await store.resolvePrincipalTeamContext(teamId, principal);
	if (!context) throw new ServiceOperationError(403, 'team_access_denied', 'The principal cannot access this team.');
	if (ownerOnly && !context.roles?.includes('team_owner'))
		throw new ServiceOperationError(403, 'team_owner_required', 'Team owner authority is required.');
	if (!ownerOnly && !await store.principalCanManageServices(principal, teamId))
		throw new ServiceOperationError(403, 'service_permission_denied', 'Service credential administration authority is required.');
	return principal;
}

function validatePrivateEnvelope(value: any) {
	if (!value || value.version !== SERVICE_VAULT_ENCRYPTION_VERSION || value.algorithm !== 'xchacha20-poly1305-ietf'
		|| value.kdf?.algorithm !== 'argon2id' || !base64.test(String(value.publicKey ?? ''))
		|| !base64.test(String(value.ciphertext ?? '')) || !base64.test(String(value.nonce ?? ''))
		|| !base64.test(String(value.kdf?.salt ?? '')) || !Number.isSafeInteger(value.kdf?.opsLimit)
		|| !Number.isSafeInteger(value.kdf?.memLimit))
		throw new ServiceOperationError(400, 'invalid_user_vault_key', 'The encrypted personal vault-key envelope is invalid.');
}

function userKey(row: any) {
	return row ? { id: row.id, userId: row.user_id, publicKey: row.public_key,
		encryptedPrivateKeyEnvelope: json(row.encrypted_private_key_envelope_json), version: Number(row.version),
		createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function grant(row: any) {
	return row ? { id: row.id, teamId: row.team_id, userId: row.user_id, userVaultKeyId: row.user_vault_key_id,
		publicKey: row.public_key, wrappedTeamVaultKey: row.wrapped_team_vault_key, keyVersion: Number(row.key_version),
		status: row.status, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function credentialEnvelope(row: any) {
	return row ? { id: row.id, teamId: row.team_id, connectionId: row.connection_id,
		credentialProfileId: row.credential_profile_id, definitionId: row.definition_id, fieldKey: row.field_key,
		keyVersion: Number(row.key_version), envelope: json(row.envelope_json), fingerprint: row.fingerprint,
		status: row.status, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function lease(row: any) {
	if (!row) return null;
	const expiresAt = String(row.expires_at);
	const status = row.status !== 'consumed' && row.status !== 'cancelled' && row.status !== 'failed'
		&& Date.parse(expiresAt) <= Date.now() ? 'expired' : row.status;
	return { id: row.id, teamId: row.team_id, connectionId: row.connection_id, capabilityType: row.capability_type,
		purpose: row.purpose, resourceScope: json(row.resource_scope_json), credentialProfileId: row.credential_profile_id,
		actorUserId: row.actor_user_id, requiredFields: json(row.required_fields_json, []), publicKey: row.public_key ?? undefined,
		status, expiresAt, consumedAt: row.consumed_at ?? null, operationCorrelationId: row.operation_correlation_id,
		hostedBinding: row.hosted_binding_json ? json(row.hosted_binding_json) : undefined,
		authorityRequests: row.authority_requests_json ? json(row.authority_requests_json, []) : undefined,
		createdAt: row.created_at, updatedAt: row.updated_at };
}

async function teamVault(store: any, teamId: string, userId: string) {
	const vault = await store.first('SELECT * FROM team_service_vaults WHERE team_id = ?', [teamId]);
	if (!vault) return null;
	const rows = await store.all(`SELECT g.*, k.public_key FROM team_service_vault_grants g
		INNER JOIN user_service_vault_keys k ON k.id = g.user_vault_key_id
		WHERE g.team_id = ? ORDER BY g.created_at`, [teamId]);
	const grants = rows.map(grant);
	return { teamId, encryptionVersion: vault.encryption_version, activeKeyVersion: Number(vault.active_key_version),
		grants, ownGrant: grants.find((item: any) => item.userId === userId && item.status === 'active'
			&& item.keyVersion === Number(vault.active_key_version)) ?? null,
		createdAt: vault.created_at, updatedAt: vault.updated_at };
}

async function requireOwnGrant(store: any, teamId: string, userId: string) {
	const vault = await teamVault(store, teamId, userId);
	if (!vault?.ownGrant) throw new ServiceOperationError(403, 'team_vault_grant_required', 'An active grant for the current team vault key is required.');
	return vault;
}

async function verifyCurrentPassword(store: any, principal: Principal, password: unknown) {
	if (admin(principal)) return;
	if (typeof password !== 'string' || !password)
		throw new ServiceOperationError(403, 'recent_authentication_required', 'Current account password verification is required.');
	const credential = await store.first("SELECT password_hash FROM control_plane_auth_credentials WHERE user_id=? AND status='active' LIMIT 1", [principal!.id]);
	if (!credential || !verifyControlPlanePassword(password, credential.password_hash))
		throw new ServiceOperationError(403, 'recent_authentication_failed', 'Current account password verification failed.');
}

export function createServiceVaultService(store: any) {
	return {
		async userVaultKey(principal: Principal) {
			if (!principal) throw new ServiceOperationError(401, 'authentication_required', 'Authentication is required.');
			return userKey(await store.first('SELECT * FROM user_service_vault_keys WHERE user_id = ?', [principal.id]));
		},
		async putUserVaultKey(principal: Principal, body: Record<string, unknown>) {
			if (!principal) throw new ServiceOperationError(401, 'authentication_required', 'Authentication is required.');
			validatePrivateEnvelope(body.encryptedPrivateKeyEnvelope);
			if (body.publicKey !== (body.encryptedPrivateKeyEnvelope as any).publicKey)
				throw new ServiceOperationError(400, 'user_vault_key_mismatch', 'The public key must match the encrypted private-key envelope.');
			const now = new Date().toISOString(), existing = await store.first('SELECT id FROM user_service_vault_keys WHERE user_id = ?', [principal.id]);
			const id = existing?.id ?? randomUUID();
			await store.run(`INSERT INTO user_service_vault_keys (id,user_id,public_key,encrypted_private_key_envelope_json,version,created_at,updated_at)
				VALUES (?,?,?,?,1,?,?) ON CONFLICT(user_id) DO UPDATE SET public_key=excluded.public_key,
				encrypted_private_key_envelope_json=excluded.encrypted_private_key_envelope_json,
				version=user_service_vault_keys.version+1,updated_at=excluded.updated_at`,
			[id, principal.id, body.publicKey, JSON.stringify(body.encryptedPrivateKeyEnvelope), now, now]);
			return userKey(await store.first('SELECT * FROM user_service_vault_keys WHERE id = ?', [id]));
		},
		async teamVault(principal: Principal, teamId: string) {
			const actor = await authorize(store, principal, teamId);
			return teamVault(store, teamId, actor.id);
		},
		async initializeTeamVault(principal: Principal, teamId: string, body: Record<string, unknown>) {
			const actor = await authorize(store, principal, teamId, true);
			if (await store.first('SELECT team_id FROM team_service_vaults WHERE team_id = ?', [teamId]))
				throw new ServiceOperationError(409, 'team_vault_exists', 'The team service vault is already initialized.');
			const key = await store.first('SELECT * FROM user_service_vault_keys WHERE id = ? AND user_id = ?', [body.userVaultKeyId, actor.id]);
			if (!key || !base64.test(String(body.wrappedTeamVaultKey ?? '')))
				throw new ServiceOperationError(400, 'invalid_team_vault_grant', 'A valid personal vault key and wrapped team key are required.');
			const now = new Date().toISOString(), id = randomUUID();
			await store.batch([
				{ query: 'INSERT INTO team_service_vaults (team_id,encryption_version,active_key_version,created_by_user_id,created_at,updated_at) VALUES (?,?,1,?,?,?)',
					params: [teamId, SERVICE_VAULT_ENCRYPTION_VERSION, actor.id, now, now] },
				{ query: `INSERT INTO team_service_vault_grants (id,team_id,user_id,user_vault_key_id,key_version,wrapped_team_vault_key,status,created_at,updated_at)
					VALUES (?,?,?,?,1,?,'active',?,?)`, params: [id, teamId, actor.id, key.id, body.wrappedTeamVaultKey, now, now] },
			]);
			return teamVault(store, teamId, actor.id);
		},
		async resetTeamVault(principal: Principal, teamId: string, body: Record<string, unknown>) {
			const actor = await authorize(store, principal, teamId, true);
			const team = await store.getTeam(teamId);
			if (body.confirmation !== `RESET ${team?.name ?? ''}`) throw new ServiceOperationError(400, 'team_vault_reset_confirmation_required', 'Enter the exact team vault reset confirmation.');
			await verifyCurrentPassword(store, actor, body.currentPassword);
			const key = await store.first('SELECT * FROM user_service_vault_keys WHERE id = ? AND user_id = ?', [body.userVaultKeyId, actor.id]);
			if (!key || !base64.test(String(body.wrappedTeamVaultKey ?? ''))) throw new ServiceOperationError(400, 'invalid_team_vault_grant', 'A valid replacement team grant is required.');
			const now = new Date().toISOString(), id = randomUUID();
			await store.batch([
				{ query: 'DELETE FROM service_operation_leases WHERE team_id = ?', params: [teamId] },
				{ query: 'DELETE FROM team_service_credential_envelopes WHERE team_id = ?', params: [teamId] },
				{ query: 'DELETE FROM team_service_vault_grants WHERE team_id = ?', params: [teamId] },
				{ query: 'DELETE FROM team_service_vaults WHERE team_id = ?', params: [teamId] },
				{ query: 'INSERT INTO team_service_vaults (team_id,encryption_version,active_key_version,created_by_user_id,created_at,updated_at) VALUES (?,?,1,?,?,?)',
					params: [teamId, SERVICE_VAULT_ENCRYPTION_VERSION, actor.id, now, now] },
				{ query: `INSERT INTO team_service_vault_grants (id,team_id,user_id,user_vault_key_id,key_version,wrapped_team_vault_key,status,created_at,updated_at)
					VALUES (?,?,?,?,1,?,'active',?,?)`, params: [id, teamId, actor.id, key.id, body.wrappedTeamVaultKey, now, now] },
			]);
			return teamVault(store, teamId, actor.id);
		},
		async grantCandidates(principal: Principal, teamId: string) {
			await authorize(store, principal, teamId, true);
			const rows = await store.all(`SELECT m.user_id, u.display_name, u.email, k.id AS user_vault_key_id, k.public_key
				FROM team_memberships m INNER JOIN users u ON u.id=m.user_id INNER JOIN user_service_vault_keys k ON k.user_id=m.user_id
				WHERE m.team_id=? AND m.status='active' AND NOT EXISTS (
					SELECT 1 FROM team_service_vault_grants g WHERE g.team_id=m.team_id AND g.user_id=m.user_id AND g.status='active')
				ORDER BY u.display_name,u.email`, [teamId]);
			return rows.map((row: any) => ({ userId: row.user_id, userVaultKeyId: row.user_vault_key_id,
				publicKey: row.public_key, displayName: row.display_name ?? row.email ?? row.user_id, roles: [] }));
		},
		async createGrant(principal: Principal, teamId: string, body: Record<string, unknown>) {
			const actor = await authorize(store, principal, teamId, true);
			const vault = await requireOwnGrant(store, teamId, actor.id);
			const key = await store.first('SELECT * FROM user_service_vault_keys WHERE id=? AND user_id=?', [body.userVaultKeyId, body.userId]);
			if (!key || !base64.test(String(body.wrappedTeamVaultKey ?? ''))) throw new ServiceOperationError(400, 'invalid_team_vault_grant', 'A valid recipient key and wrapped team key are required.');
			const now = new Date().toISOString(), id = randomUUID();
			await store.run(`INSERT INTO team_service_vault_grants (id,team_id,user_id,user_vault_key_id,key_version,wrapped_team_vault_key,status,created_at,updated_at)
				VALUES (?,?,?,?,?,?,'active',?,?) ON CONFLICT(team_id,user_id,key_version) DO UPDATE SET
				user_vault_key_id=excluded.user_vault_key_id,wrapped_team_vault_key=excluded.wrapped_team_vault_key,status='active',updated_at=excluded.updated_at`,
			[id, teamId, body.userId, key.id, vault.activeKeyVersion, body.wrappedTeamVaultKey, now, now]);
			return teamVault(store, teamId, actor.id);
		},
		async rotateTeamVault(principal: Principal, teamId: string, body: Record<string, unknown>) {
			const actor = await authorize(store, principal, teamId, true), vault = await requireOwnGrant(store, teamId, actor.id);
			if (Number(body.expectedKeyVersion) !== vault.activeKeyVersion)
				throw new ServiceOperationError(409, 'team_vault_rotation_stale', 'The team vault key changed after it was inspected.');
			const currentEnvelopes = await store.all("SELECT id FROM team_service_credential_envelopes WHERE team_id=? AND status='active' ORDER BY id", [teamId]);
			const currentGrants = await store.all("SELECT user_id,user_vault_key_id FROM team_service_vault_grants WHERE team_id=? AND status='active' AND key_version=? ORDER BY user_id",
				[teamId, vault.activeKeyVersion]);
			const envelopes = Array.isArray(body.envelopes) ? body.envelopes as any[] : [];
			const grants = Array.isArray(body.grants) ? body.grants as any[] : [];
			if (JSON.stringify(currentEnvelopes.map((item: any) => item.id).sort()) !== JSON.stringify(envelopes.map((item) => item.id).sort())
				|| envelopes.some((item) => !validateEncryptedCredentialEnvelope(item.envelope)))
				throw new ServiceOperationError(409, 'team_vault_rotation_envelopes_incomplete', 'Every active credential envelope must be rewrapped exactly once.');
			if (JSON.stringify(currentGrants.map((item: any) => `${item.user_id}:${item.user_vault_key_id}`).sort())
				!== JSON.stringify(grants.map((item) => `${item.userId}:${item.userVaultKeyId}`).sort())
				|| grants.some((item) => !base64.test(String(item.wrappedTeamVaultKey ?? ''))))
				throw new ServiceOperationError(409, 'team_vault_rotation_grants_incomplete', 'Every active administrator grant must be replaced exactly once.');
			const now = new Date().toISOString(), nextVersion = vault.activeKeyVersion + 1;
			const statements: any[] = [
				{ query: "UPDATE team_service_vault_grants SET status='superseded',updated_at=? WHERE team_id=? AND status='active'", params: [now, teamId] },
				...grants.map((item) => ({ query: `INSERT INTO team_service_vault_grants (id,team_id,user_id,user_vault_key_id,key_version,wrapped_team_vault_key,status,created_at,updated_at)
					VALUES (?,?,?,?,?,?,'active',?,?)`, params: [randomUUID(), teamId, item.userId, item.userVaultKeyId, nextVersion, item.wrappedTeamVaultKey, now, now] })),
				...envelopes.map((item) => ({ query: 'UPDATE team_service_credential_envelopes SET key_version=?,envelope_json=?,fingerprint=?,updated_at=? WHERE id=? AND team_id=?',
					params: [nextVersion, JSON.stringify(item.envelope), item.envelope.fingerprint, now, item.id, teamId] })),
				{ query: 'UPDATE team_service_vaults SET active_key_version=?,updated_at=? WHERE team_id=? AND active_key_version=?',
					params: [nextVersion, now, teamId, vault.activeKeyVersion] },
			];
			await store.batch(statements);
			return teamVault(store, teamId, actor.id);
		},
		async deleteGrant(principal: Principal, teamId: string, grantId: string) {
			const actor = await authorize(store, principal, teamId, true);
			const target = await store.first('SELECT * FROM team_service_vault_grants WHERE id=? AND team_id=?', [grantId, teamId]);
			if (!target) throw new ServiceOperationError(404, 'team_vault_grant_not_found', 'Team vault grant not found.');
			if (target.user_id === actor.id) throw new ServiceOperationError(409, 'own_team_vault_grant_required', 'Grant another owner access before revoking your own grant.');
			await store.run("UPDATE team_service_vault_grants SET status='revoked',updated_at=? WHERE id=?", [new Date().toISOString(), grantId]);
			return { id: grantId, status: 'revoked' };
		},
		async credentialEnvelopes(principal: Principal, teamId: string, connectionId?: string) {
			const actor = await authorize(store, principal, teamId); await requireOwnGrant(store, teamId, actor.id);
			const rows = await store.all(`SELECT e.*,p.definition_id FROM team_service_credential_envelopes e
				INNER JOIN team_service_credential_profiles p ON p.id=e.credential_profile_id
				WHERE e.team_id=? ${connectionId ? 'AND e.connection_id=?' : ''} AND e.status='active' ORDER BY e.connection_id,p.definition_id,e.field_key`,
			connectionId ? [teamId, connectionId] : [teamId]);
			return rows.map(credentialEnvelope);
		},
		async putCredentialEnvelope(principal: Principal, teamId: string, connectionId: string, body: Record<string, unknown>) {
			const actor = await authorize(store, principal, teamId); const vault = await requireOwnGrant(store, teamId, actor.id);
			const connection = await store.getTeamServiceConnection(teamId, connectionId);
			if (!connection) throw new ServiceOperationError(404, 'service_connection_not_found', 'Service connection not found.');
			const definitionId = String(body.definitionId ?? ''), fieldKey = String(body.fieldKey ?? '');
			const profile = getServiceProviderDefinition(connection.providerId)?.credentialProfiles.find((item) => item.id === definitionId);
			if (!profile?.fields.some((field) => field.key === fieldKey && field.sensitive))
				throw new ServiceOperationError(400, 'credential_field_not_supported', 'The provider credential field is not supported.');
			if (Number(body.keyVersion) !== vault.activeKeyVersion || !validateEncryptedCredentialEnvelope(body.envelope))
				throw new ServiceOperationError(409, 'credential_envelope_key_mismatch', 'Credential ciphertext must bind the active team vault key.');
			const forbidden = containsForbiddenPlaintextSecretMaterial(body.envelope);
			if (forbidden.length) throw new ServiceOperationError(400, 'plaintext_secret_rejected', 'Credential plaintext is forbidden.');
			let savedProfile = await store.first('SELECT * FROM team_service_credential_profiles WHERE connection_id=? AND definition_id=?', [connectionId, definitionId]);
			const now = new Date().toISOString();
			if (!savedProfile) {
				const profileId = randomUUID();
				await store.run(`INSERT INTO team_service_credential_profiles (id,team_id,connection_id,definition_id,custody_mode,status,envelope_version,fingerprint,last_rotated_at,created_at,updated_at)
					VALUES (?,?,?,?,'client_encrypted_vault','configured',?,?,?, ?,?)`,
				[profileId, teamId, connectionId, definitionId, SERVICE_VAULT_ENCRYPTION_VERSION, (body.envelope as any).fingerprint, now, now, now]);
				savedProfile = await store.first('SELECT * FROM team_service_credential_profiles WHERE id=?', [profileId]);
			}
			const existing = await store.first('SELECT id FROM team_service_credential_envelopes WHERE connection_id=? AND credential_profile_id=? AND field_key=?',
				[connectionId, savedProfile.id, fieldKey]), id = existing?.id ?? randomUUID();
			await store.run(`INSERT INTO team_service_credential_envelopes (id,team_id,connection_id,credential_profile_id,field_key,key_version,envelope_json,fingerprint,status,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(connection_id,credential_profile_id,field_key) DO UPDATE SET
				key_version=excluded.key_version,envelope_json=excluded.envelope_json,fingerprint=excluded.fingerprint,status='active',updated_at=excluded.updated_at`,
			[id, teamId, connectionId, savedProfile.id, fieldKey, vault.activeKeyVersion, JSON.stringify(body.envelope), (body.envelope as any).fingerprint, now, now]);
			await store.run(`UPDATE team_service_credential_profiles SET status='configured',envelope_version=?,fingerprint=?,last_rotated_at=?,updated_at=? WHERE id=?`,
				[SERVICE_VAULT_ENCRYPTION_VERSION, (body.envelope as any).fingerprint, now, now, savedProfile.id]);
			return credentialEnvelope(await store.first(`SELECT e.*,p.definition_id FROM team_service_credential_envelopes e
				INNER JOIN team_service_credential_profiles p ON p.id=e.credential_profile_id WHERE e.id=?`, [id]));
		},
		async createLease(principal: Principal, teamId: string, body: Record<string, unknown>) {
			const actor = await authorize(store, principal, teamId); await requireOwnGrant(store, teamId, actor.id);
			if (!SECRET_OPERATION_PURPOSES.includes(body.purpose as any)) throw new ServiceOperationError(400, 'service_operation_purpose_invalid', 'The credential operation purpose is invalid.');
			const connection = await store.getTeamServiceConnection(teamId, String(body.connectionId ?? ''));
			if (!connection) throw new ServiceOperationError(404, 'service_connection_not_found', 'Service connection not found.');
			const profile = getServiceProviderDefinition(connection.providerId)?.credentialProfiles.find((item) => item.id === body.credentialProfileId);
			if (!profile) throw new ServiceOperationError(400, 'credential_profile_not_found', 'Credential profile not found.');
			const requiredFields = profile.fields.filter((field) => field.sensitive && field.required).map((field) => field.key);
			if (!profile.capabilities.includes(String(body.capabilityType ?? '')))
				throw new ServiceOperationError(400, 'credential_capability_mismatch', 'The credential profile does not grant the requested capability.');
			const binding = await store.first(`SELECT id FROM team_service_capability_bindings WHERE team_id=? AND connection_id=?
				AND capability_type=? AND credential_profile_id=? AND status='configured'`,
			[teamId, connection.id, body.capabilityType, profile.id]);
			if (!binding) throw new ServiceOperationError(409, 'credential_capability_unavailable', 'The requested credential capability is not configured.');
			const savedProfile = await store.first(`SELECT id FROM team_service_credential_profiles WHERE team_id=? AND connection_id=?
				AND definition_id=? AND status='configured'`, [teamId, connection.id, profile.id]);
			const available = savedProfile ? await store.all(`SELECT field_key FROM team_service_credential_envelopes
				WHERE team_id=? AND connection_id=? AND credential_profile_id=? AND status='active'`,
			[teamId, connection.id, savedProfile.id]) : [];
			const availableFields = new Set(available.map((row: any) => String(row.field_key)));
			if (requiredFields.some((field) => !availableFields.has(field)))
				throw new ServiceOperationError(409, 'credential_profile_incomplete', 'Every required credential field must be configured before creating a lease.');
			const leaseFields = profile.fields.filter((field) => field.sensitive && availableFields.has(field.key)).map((field) => field.key);
			const hostedBinding = body.hostedBinding;
			if (String(body.purpose).startsWith('hosted-topology-') && !validateHostedSecretOperationBinding(hostedBinding))
				throw new ServiceOperationError(400, 'hosted_lease_binding_invalid', 'Hosted credential leases require an exact topology binding.');
			const now = new Date(), id = randomUUID(), correlationId = randomUUID(), expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
			await store.run(`INSERT INTO service_operation_leases (id,team_id,connection_id,capability_type,purpose,resource_scope_json,
				credential_profile_id,actor_user_id,required_fields_json,status,expires_at,operation_correlation_id,hosted_binding_json,
				authority_requests_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'awaiting-runner',?,?,?,?,?,?)`,
			[id, teamId, connection.id, body.capabilityType, body.purpose, JSON.stringify(body.resourceScope ?? {}), profile.id,
				actor.id, JSON.stringify(leaseFields), expiresAt, correlationId, hostedBinding ? JSON.stringify(hostedBinding) : null,
				body.authorityRequests ? JSON.stringify(body.authorityRequests) : null, now.toISOString(), now.toISOString()]);
			if (body.purpose === 'provider-connection-validation') {
				await store.createPlatformOperation({ namespace: 'security', operation: 'service-credential-validation',
					target: 'control_plane_operations_runner', idempotencyKey: body.idempotencyKey ?? `service-validation:${id}`,
					input: { teamId, leaseId: id }, requestedByType: 'user', requestedById: actor.id });
			}
			return lease(await store.first('SELECT * FROM service_operation_leases WHERE id=?', [id]));
		},
		async operationLease(principal: Principal, teamId: string, leaseId: string) {
			const actor = await authorize(store, principal, teamId);
			const row = await store.first('SELECT * FROM service_operation_leases WHERE id=? AND team_id=?', [leaseId, teamId]);
			if (!row) throw new ServiceOperationError(404, 'service_operation_lease_not_found', 'Credential operation lease not found.');
			if (!admin(actor) && row.actor_user_id !== actor.id) throw new ServiceOperationError(403, 'service_operation_lease_denied', 'Only the authorizing user can inspect this lease.');
			return lease(row);
		},
		async putLeasePayload(principal: Principal, teamId: string, leaseId: string, body: Record<string, unknown>) {
			const actor = await authorize(store, principal, teamId);
			const row = await store.first('SELECT * FROM service_operation_leases WHERE id=? AND team_id=?', [leaseId, teamId]);
			if (!row || (!admin(actor) && row.actor_user_id !== actor.id)) throw new ServiceOperationError(404, 'service_operation_lease_not_found', 'Credential operation lease not found.');
			if (row.status !== 'pending' || !row.public_key || Date.parse(row.expires_at) <= Date.now())
				throw new ServiceOperationError(409, 'service_operation_lease_not_pending', 'The runner is not awaiting a payload for this lease.');
			if (typeof body.sealedPayload !== 'string' || !base64.test(body.sealedPayload))
				throw new ServiceOperationError(400, 'sealed_payload_invalid', 'A valid sealed credential payload is required.');
			const delivered = await store.run("UPDATE service_operation_leases SET sealed_payload=?,status='ready',updated_at=? WHERE id=? AND status='pending'",
				[body.sealedPayload, new Date().toISOString(), leaseId]);
			if (Number(delivered?.meta?.changes ?? delivered?.changes ?? 0) !== 1)
				throw new ServiceOperationError(409, 'service_operation_lease_delivery_conflict', 'The credential lease changed before payload delivery.');
			return lease(await store.first('SELECT * FROM service_operation_leases WHERE id=?', [leaseId]));
		},
	};
}
