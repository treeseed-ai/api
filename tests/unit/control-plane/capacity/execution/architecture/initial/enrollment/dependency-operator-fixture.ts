import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, SignJWT } from 'jose';
import { z } from 'zod';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createIdentityAuthenticator } from '../../../../../../../../src/api/auth/identity-authenticator.ts';
import { createIdentityPrincipalStore } from '../../../../../../../../src/api/auth/identity/principal-store.ts';
import { AUTH_SCHEMA_SQL } from '../../../../../../../../src/api/auth/postgres-store.ts';
import { decodeConfirmation, encodeConfirmation } from '../../../../../../../../src/api/control-plane/confirmation/confirmation-service.ts';
import { TreeDxDelegationAuthority } from '../../../../../../../../src/api/control-plane/treedx/delegation-authority.ts';
import { ControlPlaneStore } from '../../../../../../../../src/api/persistence/store.ts';
import { createPlatformApiApp } from '../../../../../../../../src/api/support/app.ts';
import { postgresGraph } from '../../../graph/architecture/living/living-postgres-fixture.ts';
import { registrationProofInputs } from './dependency-registration-fixture.ts';

// One existing fresh PostgreSQL fixture, original migrations, original app,
// native Identity authorization transactions and app-owned confirmation SQL.
// Local account/RBAC rows and test-signed JWTs are INPUTS, NOT issuer issuance,
// managed JWKS discovery, browser enrollment, or external operator governance.
export async function dependencyOperator() {
	const f = await postgresGraph(); let directory: string | undefined;
	try {
		// These two original auth-schema statements are NOT in the control-plane
		// migrations. Preserve that prerequisite gap; do not invent a migration.
		for (const prefix of ['CREATE TABLE IF NOT EXISTS operation_confirmation_nonces', 'CREATE INDEX IF NOT EXISTS idx_operation_confirmation_nonces_expires_at']) {
			const statements = AUTH_SCHEMA_SQL.filter(sql => sql.trimStart().startsWith(prefix)); assert.equal(statements.length, 1); await f.left.pool.query(statements[0]!);
		}
		const now = new Date().toISOString(), issuer = 'https://identity.example/realms/treeseed', audience = 'http://localhost';
		await f.left.pool.query("INSERT INTO users(id,status,display_name,metadata_json,created_at,updated_at) VALUES('mapped-operator','active','Renamed operator','{}',$1,$1)", [now]);
		await f.left.pool.query("INSERT INTO user_identities(id,user_id,provider,provider_subject,created_at,updated_at) VALUES('operator-identity','mapped-operator',$1,'operator-subject',$2,$2)", [issuer, now]);
		await f.left.pool.query("INSERT INTO roles(id,key,created_at) VALUES('operator-role','renamed-operator-role',$1),('team-owner-role','team_owner',$1) ON CONFLICT(key) DO NOTHING", [now]);
		await f.left.pool.query("INSERT INTO permissions(id,key,resource,action,scope,created_at) VALUES('operator-permission','*:*:*','*','*','*',$1) ON CONFLICT(key) DO NOTHING", [now]);
		await f.left.pool.query("INSERT INTO role_permissions(role_id,permission_id,created_at) SELECT roles.id,permissions.id,$1 FROM roles,permissions WHERE roles.key='renamed-operator-role' AND permissions.key='*:*:*'", [now]);
		await f.left.pool.query("INSERT INTO user_role_bindings(id,user_id,role_id,created_at) SELECT 'operator-binding','mapped-operator',id,$1 FROM roles WHERE key='renamed-operator-role'", [now]);
		await f.left.pool.query("INSERT INTO team_memberships(id,team_id,user_id,status,created_at,updated_at) VALUES('operator-team-membership','team','mapped-operator','active',$1,$1)", [now]);
		await f.left.pool.query("INSERT INTO team_role_bindings(id,team_membership_id,role_id,created_at) SELECT 'operator-team-role','operator-team-membership',id,$1 FROM roles WHERE key='team_owner'", [now]);
		const keys = await generateKeyPair('RS256'), identity = createIdentityPrincipalStore(f.right);
		const authenticate = createIdentityAuthenticator({ issuer, audience, verificationKey: keys.publicKey, store: identity });
		const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, f.left); store.initializationPromise = Promise.resolve();
		directory = await mkdtemp(join(tmpdir(), 'dependency-operator-')); const capacityKey = join(directory, 'capacity-key'), diagnosticKey = join(directory, 'diagnostic-key');
		await writeFile(capacityKey, randomBytes(32).toString('hex'), { mode: 0o600 }); await writeFile(diagnosticKey, randomBytes(32).toString('hex'), { mode: 0o600 });
		const app = createPlatformApiApp({ db: f.left, store, identityRuntime: { authenticate, services: new Map(), metadata: { resource: audience, authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: ['treeseed:read', 'treeseed:admin'] } },
			config: { baseUrl: audience, siteUrl: audience, authSecret: randomBytes(32).toString('hex'), capacityEncryptionKeyFile: capacityKey, diagnosticsEncryptionKeyFile: diagnosticKey, TREESEED_CAPACITY_KEY_VERSION: 1, TREESEED_DIAGNOSTICS_KEY_VERSION: 1, capacityHistoricalKeyFiles: '', diagnosticsHistoricalKeyFiles: '' },
			treeDxDelegationAuthority: new TreeDxDelegationAuthority({ TREESEED_ENVIRONMENT: 'test' }) });
		const token = (options: { scope?: string; subject?: string; issuer?: string; audience?: string; client?: string; expiry?: number; key?: Parameters<SignJWT['sign']>[0] } = {}) => new SignJWT({ typ: 'Bearer', azp: options.client ?? 'renamed-client', scope: options.scope ?? 'treeseed:read treeseed:admin', roles: ['platform_admin', 'team_owner'], permissions: ['*:*:*'] })
			.setProtectedHeader({ alg: 'RS256' }).setIssuer(options.issuer ?? issuer).setAudience(options.audience ?? audience).setSubject(options.subject ?? 'operator-subject').setIssuedAt().setExpirationTime(options.expiry ?? Math.floor(Date.now() / 1000) + 47).sign(options.key ?? keys.privateKey);
		const post = (path: string, credential: string, body: Record<string, unknown>, key: string, confirmation?: string) => app.request(new Request(`${audience}${path}`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'idempotency-key': key, ...(confirmation ? { 'x-treeseed-confirmation': confirmation } : {}) }, body: JSON.stringify(body) }));
		const challenge = async (path: string, credential: string, body: Record<string, unknown>, key: string) => {
			const response = await post(path, credential, body, key); assert.equal(response.status, 409);
			const payload = z.object({ code: z.literal('confirmation_required'), inputRequired: z.object({ confirmation: z.unknown() }) }).parse(await response.json());
			const state = decodeConfirmation(Buffer.from(JSON.stringify(payload.inputRequired.confirmation)).toString('base64url')); assert.ok(state);
			assert.equal(state.principalId, 'mapped-operator'); assert.equal(state.clientId, 'renamed-client'); return state;
		};
		const state = async (database = f.left) => {
			const tables = await database.pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
			const snapshot: Record<string, unknown[]> = {};
			for (const { tablename } of tables.rows) {
				const rows = await database.pool.query<{ value: unknown }>(`SELECT to_jsonb(t) AS value FROM "${tablename.replaceAll('"', '""')}" t`);
				snapshot[tablename] = rows.rows.map(row => row.value).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
			}
			return snapshot;
		};
		const register = async () => {
			const credential = await token(), rest = CONTROL_PLANE_OPERATIONS.providers.registrationCode.reveal.descriptor.rest; assert.ok(rest);
			const path = rest.path.replace('{teamId}', 'team'), body = {}, key = 'operator-key-reveal', before = await state();
			const confirmation = await challenge(path, credential, body, key); assert.deepEqual(await state(), before);
			const reveal = await post(path, credential, body, key, encodeConfirmation(confirmation)); assert.equal(reveal.status, 200);
			const receipt = z.object({ data: z.object({ registrationCode: z.string().min(1) }) }).parse(await reveal.json());
			// Capture the original helper's three-second proof only AFTER app/key
			// setup. No Assignment/Lease/productive window is created or extended.
			const inputs = registrationProofInputs(new Date()), original = structuredClone({ body: inputs.body, payload: inputs.payload });
			const response = await app.request(new Request(`${audience}${inputs.path}`, { method: 'POST', headers: { authorization: `Treeseed-Registration ${receipt.data.registrationCode}`, 'content-type': 'application/json', 'idempotency-key': 'operator-public-registration' }, body: JSON.stringify({ ...inputs.body, proof: inputs.proof(inputs.payload) }) }));
			assert.equal(response.status, 200); assert.ok(Date.now() < Date.parse(inputs.payload.expiresAt)); assert.deepEqual({ body: inputs.body, payload: inputs.payload }, original);
			const request = CONTROL_PLANE_OPERATIONS.providers.register.schema.output.parse(await response.json());
			const data = z.object({ id: z.string().min(1), teamId: z.literal('team'), status: z.literal('pending'), providerId: z.string().min(1) }).parse(request.data);
			return { credential, request: data, inputs, approvalPath: CONTROL_PLANE_OPERATIONS.providers.requests.approve.descriptor.rest.path.replace('{teamId}', 'team').replace('{requestId}', data.id) };
		};
		const ownedDirectory = directory;
		return { ...f, app, identity, authenticate, token, post, challenge, state, register, async close() { try { await f.close(); } finally { await rm(ownedDirectory, { recursive: true, force: true }); } } };
	} catch (error) { try { await f.close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); } throw error; }
}
