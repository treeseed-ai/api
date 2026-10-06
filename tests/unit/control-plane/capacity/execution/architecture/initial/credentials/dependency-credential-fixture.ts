import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PROVIDER_MEMBERSHIP_SCOPES } from '@treeseed/sdk/capacity-provider/contracts';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { canonicalJson, capacityProviderFingerprint, sha256 } from '../../../../../../../../src/api/capacity/security.ts';
import { splitPostgresSqlStatements } from '../../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { dependencyToken, tokenProofInputs } from '../tokens/dependency-token-fixture.ts';

export function credentialProofInputs() {
	const now = new Date('2026-10-03T00:00:00.000Z'), input = tokenProofInputs(now, '2026-10-03T00:00:03.000Z');
	const body = { requestId: 'credential-request', idempotencyKey: 'original-credential-exchange' };
	const path = `/v1/provider-registrations/${body.requestId}/credential`;
	const payload = { ...input.payload, path, bodySha256: sha256(canonicalJson(body)), jti: randomUUID() };
	return { ...input, now, body, path, payload, proof: input.proof(payload), sign: input.proof };
}

// Supplied approved registration + prior authorization/credential are INPUTS.
// Actual public credential rotation creates the next pending authorization,
// revokes old credentials/tokens, then actual signed public exchange consumes it.
export async function dependencyCredential() {
	const f = await dependencyToken(PROVIDER_MEMBERSHIP_SCOPES);
	try {
		const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const name of ['idx_capacity_provider_credential_authorizations_generation', 'idx_capacity_provider_credential_authorizations_idempotency']) {
			const matches = ddl.filter(sql => sql.startsWith(`CREATE UNIQUE INDEX "${name}" `)); assert.equal(matches.length, 1); await f.db.exec(matches[0]!);
		}
		await f.query(`INSERT INTO capacity_provider_credential_issuance_authorizations
			(id,membership_id,team_id,capacity_provider_id,generation,idempotency_key,status,issued_credential_id,created_by_type,created_by_id,created_at,updated_at)
			VALUES ('supplied-credential-authority','membership','team','provider',1,'supplied-credential-input','issued','token-credential','team-principal','supplied-operator',?,?)`, [f.now, f.now]);
		await f.query(`INSERT INTO capacity_provider_registration_requests
			(id,team_id,capacity_provider_id,provider_fingerprint,registration_key_generation,status,proof_jti,idempotency_key,request_digest,expires_at,membership_id,reviewed_at,reviewed_by_id,created_at,updated_at)
			VALUES ('credential-request','team','provider',?,1,'approved','supplied-registration-proof','supplied-registration','supplied-registration-digest',?,'membership',?,'supplied-operator',?,?)`,
		[capacityProviderFingerprint(f.publicJwk), f.attempt.deadline, f.now, f.now, f.now]);
		const envelope = async (response: Response) => { assert.equal(response.status, 200); const value: unknown = await response.json();
			assert.ok(value && typeof value === 'object' && 'data' in value); return value.data; };
		const token = CONTROL_PLANE_OPERATIONS.providers.issueAccessToken.schema.output.parse(await envelope(await f.issue()));
		if (typeof token.accessToken !== 'string' || !token.accessToken) throw new Error('Issued rotation token missing');
		const rotate = CONTROL_PLANE_OPERATIONS.providers.rotateCredential.descriptor.rest; assert.ok(rotate);
		const authorization = CONTROL_PLANE_OPERATIONS.providers.rotateCredential.schema.output.parse(await envelope(await f.app.request(new Request(`http://localhost${rotate.path}`, {
			method: rotate.method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token.accessToken}`, 'idempotency-key': 'original-credential-rotation' }, body: '{}' }))));
		assert.equal(authorization.generation, 2); assert.equal(authorization.status, 'pending');
		const body = { requestId: 'credential-request', idempotencyKey: 'original-credential-exchange' }, path = `/v1/provider-registrations/${body.requestId}/credential`;
		const payload = { ...f.payload, path, bodySha256: sha256(canonicalJson(body)), jti: randomUUID() };
		const exchange = (proof = f.proof(payload), options: { key?: string; requestId?: string; body?: Record<string, unknown> } = {}) => f.app.request(new Request(
			`http://localhost/v1/provider-registrations/${encodeURIComponent(options.requestId ?? body.requestId)}/credential`, {
				method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': options.key ?? body.idempotencyKey }, body: JSON.stringify({ proof, ...options.body }) }));
		const state = async () => ({ ...await f.tokenState(), requests: (await f.query('SELECT * FROM capacity_provider_registration_requests ORDER BY id')).rows,
			authorizations: (await f.query('SELECT * FROM capacity_provider_credential_issuance_authorizations ORDER BY id')).rows });
		const issueExchanged = async (credential: string, id: string) => {
			const key = 'exchanged-credential-token', signed = { credentialId: id, idempotencyKey: key, requestedValiditySeconds: 60 };
			const response = await f.issue(f.proof({ ...f.payload, bodySha256: sha256(canonicalJson(signed)), jti: randomUUID() }), { credential, key, body: { credentialId: id } });
			const data = CONTROL_PLANE_OPERATIONS.providers.issueAccessToken.schema.output.parse(await envelope(response));
			if (typeof data.accessToken !== 'string' || !data.accessToken) throw new Error('Exchanged credential token missing'); return data.accessToken;
		};
		assert.ok(Date.now() < Date.parse(f.attempt.deadline), 'Original credential exchange window elapsed in setup');
		return { ...f, authorization, exchangeBody: body, exchangePayload: payload, exchange, credentialState: state, issueExchanged };
	} catch (error) { await f.close(); throw error; }
}
