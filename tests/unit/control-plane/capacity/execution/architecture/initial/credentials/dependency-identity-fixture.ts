import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { canonicalJson, capacityProviderFingerprint, sha256 } from '../../../../../../../../src/api/capacity/security.ts';
import { splitPostgresSqlStatements } from '../../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { dependencyToken, tokenProofInputs } from '../tokens/dependency-token-fixture.ts';

export function membershipIdentityRow() {
	const key = tokenProofInputs(new Date('2026-10-03T00:00:00.000Z'), '2026-10-03T00:00:03.000Z').publicJwk;
	return { provider_id: 'provider', fingerprint: capacityProviderFingerprint(key), public_jwk_json: JSON.stringify(key), display_name: 'Renamed configured provider',
		identity_version: 1, identity_status: 'active', membership_id: 'membership', team_id: 'team', membership_status: 'approved',
		identity_metadata_json: '{}', membership_metadata_json: '{}', membership_created_at: '2026-10-03T00:00:00.000Z', membership_updated_at: '2026-10-03T00:00:00.000Z' };
}

// SAME issued-token/public HTTP/original SQL fixture. Signed key/proof/account
// facts are INPUTS, not native enrollment or Agent coordinator production.
export async function dependencyIdentity() {
	const f = await dependencyToken();
	try {
		const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const name of ['idx_capacity_provider_identity_rotations_idempotency', 'idx_capacity_provider_identity_rotations_version']) {
			const statements = ddl.filter(sql => sql.startsWith(`CREATE UNIQUE INDEX "${name}" `)); assert.equal(statements.length, 1); await f.db.exec(statements[0]!);
		}
		const readToken = async (response: Response) => {
			assert.equal(response.status, 200); const envelope: unknown = await response.json();
			assert.ok(envelope && typeof envelope === 'object' && 'data' in envelope);
			const data = CONTROL_PLANE_OPERATIONS.providers.issueAccessToken.schema.output.parse(envelope.data);
			if (typeof data.accessToken !== 'string' || !data.accessToken || typeof data.id !== 'string') throw new Error('Issued token missing');
			return { token: data.accessToken, id: data.id };
		};
		const issued = await readToken(await f.issue());
		const next = tokenProofInputs(new Date(), f.attempt.deadline);
		const signedBody = { expectedIdentityVersion: 1, newPublicJwk: next.publicJwk };
		const digest = sha256(canonicalJson(signedBody));
		const oldPayload = { ...f.payload, path: '/v1/provider/identity/rotate', bodySha256: digest, jti: randomUUID() };
		const newPayload = { ...next.payload, path: oldPayload.path, bodySha256: digest, identityVersion: 2, jti: randomUUID() };
		const body = { ...signedBody, oldProof: f.proof(oldPayload), newProof: next.proof(newPayload) };
		const rest = CONTROL_PLANE_OPERATIONS.providers.rotateIdentity.descriptor.rest; assert.ok(rest); assert.equal(rest.method, 'POST');
		const rotate = (request: Record<string, unknown> = body, token = issued.token, key = 'original-identity-rotation') => f.app.request(new Request(`http://localhost${rest.path}`, {
			method: rest.method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': key }, body: JSON.stringify(request) }));
		const newToken = async () => {
			const key = 'rotated-identity-token';
			const signed = { ...f.body, idempotencyKey: key };
			return readToken(await f.issue(next.proof({ ...next.payload, identityVersion: 2, bodySha256: sha256(canonicalJson(signed)), jti: randomUUID() }), { key }));
		};
		const state = async () => {
			const value = await f.tokenState();
			return { ...value, tokens: value.tokens.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'last_used_at' && key !== 'updated_at'))),
				rotations: (await f.query('SELECT * FROM capacity_provider_identity_rotations ORDER BY id')).rows };
		};
		assert.ok(Date.now() < Date.parse(f.attempt.deadline), 'Original rotation window elapsed in setup');
		return { ...f, issued, next, oldPayload, newPayload, body, rotate, newToken, identityState: state };
	} catch (error) { await f.close(); throw error; }
}
