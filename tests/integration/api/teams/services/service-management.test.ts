import { canonicalServiceVaultAssociatedData } from '@treeseed/sdk/secrets-capability';
import {
authorizeApp,
createTeam,
createTestApp,
createTestPostgresDatabase,
createTestStore,
describe,
expect,
it,
json,
} from '../../../../support/api-harness.ts';

const jsonHeaders = (token: string) => ({
	authorization: `Bearer ${token}`,
	'content-type': 'application/json',
});

describe('team service management', () => {
	it('persists provider metadata and client ciphertext without accepting plaintext credentials', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const headers = jsonHeaders(token);

		const createdResponse = await app.request(`/v1/teams/${team.id}/services`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				providerId: 'cloudflare',
				displayName: 'Primary Cloudflare account',
				nonSecretConfig: { accountId: 'account-123' },
				capabilities: [{ capabilityType: 'frontend-hosting' }, { capabilityType: 'dns-management' }],
			}),
		});
		expect(createdResponse.status).toBe(201);
		const connection = (await json(createdResponse)).payload;
		expect(connection.nonSecretConfig).toEqual({ accountId: 'account-123' });
		expect(connection.capabilities.map((item: any) => item.capabilityType)).toEqual(['dns-management', 'frontend-hosting']);

		const rejected = await app.request(`/v1/teams/${team.id}/services`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				providerId: 'cloudflare',
				displayName: 'Unsafe connection',
				nonSecretConfig: { apiToken: 'plaintext-secret-canary' },
			}),
		});
		expect(rejected.status).toBe(400);
		expect(await json(rejected)).toMatchObject({ code: 'plaintext_secret_rejected' });

		const keyResponse = await app.request('/v1/users/me/vault-key', {
			method: 'PUT',
			headers,
			body: JSON.stringify({
				publicKey: 'administrator-public-key',
				encryptedPrivateKeyEnvelope: {
					version: 'service-vault-v1',
					algorithm: 'xchacha20-poly1305-ietf',
					kdf: { algorithm: 'argon2id', opsLimit: 2, memLimit: 65536, salt: 'salt' },
					nonce: 'nonce',
					ciphertext: 'private-key-ciphertext',
					publicKey: 'administrator-public-key',
				},
			}),
		});
		expect(keyResponse.status).toBe(200);
		const userKey = (await json(keyResponse)).payload;

		const vaultResponse = await app.request(`/v1/teams/${team.id}/vault`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				userVaultKeyId: userKey.id,
				wrappedTeamVaultKey: 'sealed-team-key',
				encryptionVersion: 'service-vault-v1',
			}),
		});
		expect(vaultResponse.status).toBe(201);

		const associatedData = canonicalServiceVaultAssociatedData({
			teamId: team.id,
			connectionId: connection.id,
			credentialProfileId: 'cloudflare-runtime',
			field: 'apiToken',
			purpose: 'team-service-credential',
			version: 1,
		});
		const credentialResponse = await app.request(
			`/v1/teams/${team.id}/services/${connection.id}/credential-envelopes`,
			{
				method: 'POST',
				headers,
				body: JSON.stringify({
					definitionId: 'cloudflare-runtime',
					fieldKey: 'apiToken',
					keyVersion: 1,
					envelope: {
						version: 'service-vault-v1',
						algorithm: 'xchacha20-poly1305-ietf',
						ciphertext: 'opaque-ciphertext',
						nonce: 'opaque-nonce',
						wrappedKey: 'opaque-wrapped-key',
						wrappedKeyNonce: 'opaque-key-nonce',
						associatedData,
						associatedDataDigest: 'opaque-context-digest',
						fingerprint: 'fingerprint',
					},
				}),
			},
		);
		expect(credentialResponse.status).toBe(201);

		const listed = await json(await app.request(
			`/v1/teams/${team.id}/services/${connection.id}/credential-envelopes`,
			{ headers },
		));
		expect(listed.payload).toHaveLength(1);
		expect(listed.payload[0].envelope.ciphertext).toBe('opaque-ciphertext');
		expect(JSON.stringify(listed)).not.toContain('plaintext-secret-canary');
		const authorities = (await json(await app.request(
			`/v1/teams/${team.id}/services/${connection.id}/credential-authorities`, { headers },
		))).payload;
		expect(authorities).toEqual([expect.objectContaining({ credentialProfileId: 'cloudflare-runtime',
			scheme: 'client-encrypted', status: 'interactive-only' })]);

		const vault = (await json(await app.request(`/v1/teams/${team.id}/vault`, { headers }))).payload;
		const teamEnvelopes = (await json(await app.request(
			`/v1/teams/${team.id}/vault/credential-envelopes`,
			{ headers },
		))).payload;
		const rotatedEnvelope = {
			...teamEnvelopes[0].envelope,
			wrappedKey: 'replacement-wrapped-key',
			wrappedKeyNonce: 'replacement-key-nonce',
		};
		const rotation = await app.request(`/v1/teams/${team.id}/vault/rotate`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				expectedKeyVersion: 1,
				envelopes: [{ id: teamEnvelopes[0].id, envelope: rotatedEnvelope }],
				grants: vault.grants.filter((grant: any) => grant.status === 'active').map((grant: any) => ({
					userId: grant.userId,
					userVaultKeyId: grant.userVaultKeyId,
					wrappedTeamVaultKey: 'replacement-team-key-grant',
				})),
			}),
		});
		expect(rotation.status).toBe(200);
		expect((await json(rotation)).payload.activeKeyVersion).toBe(2);
		const afterRotation = (await json(await app.request(
			`/v1/teams/${team.id}/vault/credential-envelopes`,
			{ headers },
		))).payload;
		expect(afterRotation[0].envelope).toMatchObject({
			ciphertext: 'opaque-ciphertext',
			wrappedKey: 'replacement-wrapped-key',
		});
	});

	it('scopes operation leases to one actor and one sealed payload submission', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const headers = jsonHeaders(token);
		const connection = (await json(await app.request(`/v1/teams/${team.id}/services`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				providerId: 'github',
				displayName: 'GitHub organization',
				nonSecretConfig: { organization: 'example' },
				capabilities: [{ capabilityType: 'repository-hosting', credentialProfileId: 'github-repository-token' }],
			}),
		}))).payload;

		const authorized = await app.request(`/v1/teams/${team.id}/service-operation-leases`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				connectionId: connection.id,
				capabilityType: 'repository-hosting',
				credentialProfileId: 'github-repository-token',
				purpose: 'provider-connection-validation',
				idempotencyKey: 'validation-operation-1',
			}),
		});
		expect(authorized.status).toBe(201);
		const lease = (await json(authorized)).payload;
		expect(lease).toMatchObject({ status: 'awaiting-runner', publicKey: '' });

		const awaiting = await store.listAwaitingSecretOperationLeases();
		expect(awaiting.map((item) => item.id)).toContain(lease.id);
		const registered = await store.registerSecretOperationLeaseKey(lease.id, 'ephemeral-runner-public-key');
		expect(registered).toMatchObject({ status: 'pending', publicKey: 'ephemeral-runner-public-key' });

		const first = await app.request(`/v1/teams/${team.id}/service-operation-leases/${lease.id}/payload`, {
			method: 'PUT',
			headers,
			body: JSON.stringify({ sealedPayload: 'sealed-operation-payload' }),
		});
		expect(first.status).toBe(200);

		const replay = await app.request(`/v1/teams/${team.id}/service-operation-leases/${lease.id}/payload`, {
			method: 'PUT',
			headers,
			body: JSON.stringify({ sealedPayload: 'sealed-operation-payload' }),
		});
		expect(replay.status).toBe(409);
		expect(await json(replay)).toMatchObject({ code: 'already_used' });

		const callerKey = await app.request(`/v1/teams/${team.id}/service-operation-leases`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				connectionId: connection.id,
				capabilityType: 'repository-hosting',
				credentialProfileId: 'github-repository-app',
				purpose: 'provider-connection-validation',
				publicKey: 'caller-controlled-key',
				idempotencyKey: 'validation-operation-2',
			}),
		});
		expect(callerKey.status).toBe(400);
		expect(await json(callerKey)).toMatchObject({ code: 'invalid_operation_lease' });
	});

	it('rejects unverified GitHub App installation authority through the generic authority endpoint', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const headers = jsonHeaders(token);
		const connection = (await json(await app.request(`/v1/teams/${team.id}/services`, {
			method: 'POST', headers,
			body: JSON.stringify({
				providerId: 'github', displayName: 'Managed GitHub organization',
				nonSecretConfig: { organization: 'example' },
				capabilities: [{ capabilityType: 'repository-hosting', credentialProfileId: 'github-repository-app' }],
			}),
		}))).payload;

		const response = await app.request(`/v1/teams/${team.id}/services/${connection.id}/credential-authorities/github-repository-app`, {
			method: 'PUT', headers,
			body: JSON.stringify({ scheme: 'app-installation', reference: 'unverified-installation-42' }),
		});
		expect(response.status).toBe(409);
		expect(await json(response)).toMatchObject({ code: 'credential_authority_connector_required' });
	});

	it('purges every connection-owned secret record when an unused service is disconnected', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const headers = jsonHeaders(token);
		const now = new Date().toISOString();
		const connection = (await json(await app.request(`/v1/teams/${team.id}/services`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				providerId: 'railway',
				displayName: 'Disposable Railway workspace',
				nonSecretConfig: { workspaceId: 'workspace-cleanup' },
				capabilities: [{ capabilityType: 'backend-hosting', credentialProfileId: 'railway-workspace' }],
			}),
		}))).payload;

		await db.batch([
			{
				query: `INSERT INTO team_service_credential_profiles (
					id, team_id, connection_id, definition_id, custody_mode, status, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, 'configured', ?, ?)`,
				params: ['profile-cleanup', team.id, connection.id, 'railway-workspace', 'client-encrypted-vault', now, now],
			},
			{
				query: `INSERT INTO credential_envelopes (
					id, team_id, connection_id, credential_profile_id, field_key, envelope_json,
					fingerprint, key_version, status, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`,
				params: ['envelope-cleanup', team.id, connection.id, 'profile-cleanup', 'token', '{}', 'fingerprint-cleanup', now, now],
			},
			{
				query: `INSERT INTO external_vault_bindings (
					id, team_id, connection_id, provider, reference_json, auth_mode, status, created_at, updated_at
				) VALUES (?, ?, ?, 'openbao', '{}', 'oidc-workload-identity', 'active', ?, ?)`,
				params: ['binding-cleanup', team.id, connection.id, now, now],
			},
		]);
		const lease = await app.request(`/v1/teams/${team.id}/service-operation-leases`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				connectionId: connection.id,
				capabilityType: 'backend-hosting',
				credentialProfileId: 'railway-workspace',
				purpose: 'provider-connection-validation',
				idempotencyKey: 'cleanup-operation',
			}),
		});
		expect(lease.status).toBe(201);

		const disconnected = await app.request(`/v1/teams/${team.id}/services/${connection.id}`, {
			method: 'DELETE',
			headers,
		});
		expect(disconnected.status).toBe(200);
		expect(await json(disconnected)).toMatchObject({
			ok: true,
			payload: { id: connection.id, status: 'disconnected', capabilities: [], credentialProfiles: [] },
		});
		expect(await store.getTeamServiceConnection(team.id, connection.id)).toBeNull();

		const connectionCount = await db.prepare(
			`SELECT COUNT(*)::integer AS count FROM team_service_connections WHERE team_id = ? AND id = ?`,
		).bind(team.id, connection.id).first();
		expect(connectionCount?.count).toBe(0);
		for (const table of [
			'team_service_capability_bindings',
			'team_service_credential_profiles',
			'credential_envelopes',
			'external_vault_bindings',
			'secret_operation_leases',
		]) {
			const row = await db.prepare(`SELECT COUNT(*)::integer AS count FROM ${table} WHERE team_id = ? AND connection_id = ?`)
				.bind(team.id, connection.id)
				.first();
			expect(row?.count, table).toBe(0);
		}
	});
});
