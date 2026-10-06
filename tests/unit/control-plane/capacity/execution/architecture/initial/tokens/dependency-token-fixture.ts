import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapacityProviderProofPayload, CapacityProviderPublicJwk, ProviderMembershipScope } from '@treeseed/sdk/capacity-provider/contracts';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { capacityProviderFingerprint, canonicalJson, sha256 } from '../../../../../../../../src/api/capacity/security.ts';
import { splitPostgresSqlStatements } from '../../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { dependencyPublicPoll } from '../polling/dependency-public-poll-fixture.ts';

// Controlled signed INPUTS, not a second product signer/validator, Agent identity
// issuance, governance, or provider runtime. Node signs; original API verifies.
export function tokenProofInputs(now: Date, deadline: string, audience = 'http://localhost') {
	const keys = generateKeyPairSync('ed25519'), exported = keys.publicKey.export({ format: 'jwk' });
	assert.equal(exported.kty, 'OKP'); assert.equal(exported.crv, 'Ed25519'); assert.equal(typeof exported.x, 'string');
	if (typeof exported.x !== 'string') throw new Error('Ed25519 public x required');
	const publicJwk: CapacityProviderPublicJwk = { kty: 'OKP', crv: 'Ed25519', x: exported.x, alg: 'EdDSA' };
	const body = { credentialId: 'token-credential', idempotencyKey: 'signed-token-issue', requestedValiditySeconds: 60 };
	const payload: CapacityProviderProofPayload = { schemaVersion: 1, algorithm: 'Ed25519', providerFingerprint: capacityProviderFingerprint(publicJwk),
		identityVersion: 1, method: 'POST', path: '/v1/provider/access-tokens', audience,
		bodySha256: sha256(canonicalJson(body)), issuedAt: now.toISOString(), expiresAt: deadline, jti: randomUUID() };
	const proof = (value: CapacityProviderProofPayload = payload, header = { alg: 'EdDSA', typ: 'JOSE' }) => {
		const protectedValue = Buffer.from(JSON.stringify(header)).toString('base64url'), encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
		return { protected: protectedValue, payload: encoded, signature: sign(null, Buffer.from(`${protectedValue}.${encoded}`), keys.privateKey).toString('base64url') };
	};
	return { publicJwk, body, payload, proof };
}

export async function dependencyToken(scopes: readonly ProviderMembershipScope[] = ['provider:assignments:read'], subscriptionReady?: Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), 'dependency-token-'));
	let f: Awaited<ReturnType<typeof dependencyPublicPoll>> | undefined;
	try {
		const value = randomBytes(32).toString('hex'), path = join(directory, 'capacity-key');
		await writeFile(path, value, { mode: 0o600 });
		f = await dependencyPublicPoll({ path, value }, subscriptionReady); const owner = f;
		const inputs = tokenProofInputs(new Date(), f.attempt.deadline);
		await f.query('UPDATE capacity_providers SET fingerprint=?,public_jwk_json=? WHERE id=\'provider\'',
			[capacityProviderFingerprint(inputs.publicJwk), JSON.stringify(inputs.publicJwk)]);
		await f.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team','signed-token-team','Signed token inputs',?,?) ON CONFLICT (id) DO NOTHING`, [f.now, f.now]);
		const credential = f.secrets.issue('credential');
		await f.query(`INSERT INTO capacity_provider_team_credentials
			(id,membership_id,team_id,capacity_provider_id,key_prefix,key_hash,issuance_authorization_id,issuance_generation,issue_idempotency_key,scopes_json,created_at,updated_at)
			VALUES ('token-credential','membership','team','provider',?,?,'supplied-credential-authority',1,'supplied-credential-input',?,?,?)`,
		[credential.prefix, credential.hash, JSON.stringify(scopes), f.now, f.now]);
		const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const name of ['idx_capacity_provider_access_tokens_prefix', 'idx_capacity_provider_access_tokens_issue',
			'idx_capacity_provider_team_credentials_prefix', 'idx_capacity_provider_team_credentials_issue', 'idx_capacity_provider_team_credentials_generation']) {
			const matches = ddl.filter(sql => sql.startsWith(`CREATE UNIQUE INDEX "${name}" `)); assert.equal(matches.length, 1);
			await f.db.exec(matches[0]!);
		}
		const rest = CONTROL_PLANE_OPERATIONS.providers.issueAccessToken.descriptor.rest; assert.ok(rest); assert.equal(rest.method, 'POST');
		const issue = (proof = inputs.proof(), options: { body?: Record<string, unknown>; credential?: string; key?: string } = {}) =>
			owner.app.request(new Request(`http://localhost${rest.path}`, { method: rest.method,
				headers: { 'content-type': 'application/json', authorization: `Treeseed-Credential ${options.credential ?? credential.plaintext}`,
					'idempotency-key': options.key ?? inputs.body.idempotencyKey },
				body: JSON.stringify({ credentialId: inputs.body.credentialId, requestedValiditySeconds: inputs.body.requestedValiditySeconds, proof, ...options.body }) }));
		const state = async () => ({ ...await owner.state(), tokens: (await owner.query('SELECT * FROM capacity_provider_access_tokens ORDER BY id')).rows,
			credentials: (await owner.query('SELECT * FROM capacity_provider_team_credentials ORDER BY id')).rows,
			nonces: (await owner.query('SELECT * FROM capacity_provider_proof_nonces ORDER BY provider_fingerprint,jti')).rows });
		assert.ok(Date.now() < Date.parse(f.attempt.deadline), 'Original three-second issuance and poll window elapsed during setup');
		return { ...f, ...inputs, issue, tokenState: state,
			async close() { try { await owner.db.close(); } finally { await rm(directory, { recursive: true, force: true }); } } };
	} catch (error) { try { await f?.db.close(); } finally { await rm(directory, { recursive: true, force: true }); } throw error; }
}
