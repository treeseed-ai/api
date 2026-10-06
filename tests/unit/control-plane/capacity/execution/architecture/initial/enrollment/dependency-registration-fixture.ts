import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import type { ProviderRegistrationSubmission } from '@treeseed/sdk/capacity-provider/contracts';
import { canonicalJson, sha256 } from '../../../../../../../../src/api/capacity/security.ts';
import { splitPostgresSqlStatements } from '../../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { dependencyToken, tokenProofInputs } from '../tokens/dependency-token-fixture.ts';

// Node key/proof inputs only. Original API verification, codec, admission,
// nonce/rate SQL, public catalog and repository own the actual behavior.
export function registrationProofInputs(now = new Date('2026-10-03T13:34:44.000Z'), deadline = new Date(now.getTime() + 3000).toISOString()) {
	const signer = tokenProofInputs(now, deadline), path = '/v1/provider-registrations';
	const body: Omit<ProviderRegistrationSubmission, 'proof'> = { schemaVersion: 1, displayName: 'Renamed supplied provider', publicJwk: signer.publicJwk,
		capabilitySummary: ['renamed.execution'], supplyOffer: { capabilities: ['renamed.execution'], weight: 1, maxConcurrentRunners: 1 }, metadata: { source: 'controlled-input' } };
	const payload = { ...signer.payload, path, bodySha256: sha256(canonicalJson(body)), jti: randomUUID() };
	return { ...signer, now, path, body, payload };
}

export async function dependencyRegistration() {
	const f = await dependencyToken();
	try {
		const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const name of ['idx_capacity_providers_fingerprint', 'idx_capacity_provider_registration_request_pending',
			'idx_capacity_provider_registration_request_proof', 'idx_capacity_provider_registration_request_idempotency',
			'idx_team_capacity_registration_keys_generation', 'idx_team_capacity_registration_keys_prefix', 'idx_team_capacity_registration_keys_rotation']) {
			const matches = ddl.filter(sql => sql.startsWith(`CREATE UNIQUE INDEX "${name}" `)); assert.equal(matches.length, 1); await f.db.exec(matches[0]!);
		}
		// Actual key creation/reveal with a supplied actor; not operator HTTP auth.
		const revealed = await f.authenticator.revealRegistrationKey('team', 'supplied-operator');
		const inputs = registrationProofInputs(new Date(), f.attempt.deadline);
		const rest = CONTROL_PLANE_OPERATIONS.providers.register.descriptor.rest; assert.ok(rest); assert.equal(rest.method, 'POST'); assert.equal(rest.path, inputs.path);
		const key = 'original-signed-registration';
		const register = (proof = inputs.proof(inputs.payload), options: { body?: Record<string, unknown>; registrationKey?: string; key?: string; authorization?: string } = {}) =>
			f.app.request(new Request(`http://localhost${rest.path}`, { method: rest.method,
				headers: { 'content-type': 'application/json', authorization: options.authorization ?? `Treeseed-Registration ${options.registrationKey ?? revealed.registrationKey}`,
					'idempotency-key': options.key ?? key }, body: JSON.stringify({ ...inputs.body, proof, ...options.body }) }));
		const state = async () => ({ ...await f.tokenState(), registrationKeys: (await f.query('SELECT * FROM team_capacity_registration_keys ORDER BY id')).rows,
			requests: (await f.query('SELECT * FROM capacity_provider_registration_requests ORDER BY id')).rows,
			rateLimits: (await f.query('SELECT * FROM capacity_provider_registration_rate_limits ORDER BY dimension,bucket_key')).rows,
			authorizations: (await f.query('SELECT * FROM capacity_provider_credential_issuance_authorizations ORDER BY id')).rows });
		assert.ok(Date.now() < Date.parse(f.attempt.deadline), 'Original three-second registration authority elapsed during setup');
		return { ...f, registrationInputs: inputs, register, registrationState: state, registrationIdempotencyKey: key };
	} catch (error) { await f.close(); throw error; }
}
