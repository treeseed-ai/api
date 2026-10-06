import assert from 'node:assert/strict';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import type { CapacityGovernanceDatabase } from '../../../../../../../../src/api/capacity/database.ts';
import { CapacityGovernanceRepository } from '../../../../../../../../src/api/capacity/repositories/governance/policy/governance.ts';
import { CapacityRegistrationService } from '../../../../../../../../src/api/capacity/services/support/registration-service.ts';
import { CapacitySecretCodec } from '../../../../../../../../src/api/capacity/security.ts';
import { dependencyToken } from '../tokens/dependency-token-fixture.ts';

// Unit read/write observation only; never claimed as native authorization.
export function revocationGuard() {
	let reads = 0, writes = 0;
	const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined,
		first: async () => { reads++; return null; }, all: async () => { reads++; return []; },
		run: async () => { writes++; throw new Error('Unexpected unit revocation write'); },
		batch: async () => { writes++; throw new Error('Unexpected unit revocation transaction'); } };
	return { service: new CapacityRegistrationService(new CapacityGovernanceRepository(database),
		new CapacitySecretCodec('controlled-unit-hash-material-only', 'controlled-unit-envelope-material-only'), 'http://localhost'), reads: () => reads, writes: () => writes };
}

export async function dependencyRevocation(subscriptionReady?: Promise<void>) {
	const f = await dependencyToken(undefined, subscriptionReady);
	try {
		const response = await f.issue(); assert.equal(response.status, 200); const value: unknown = await response.json();
		assert.ok(value && typeof value === 'object' && 'data' in value);
		const issued = CONTROL_PLANE_OPERATIONS.providers.issueAccessToken.schema.output.parse(value.data);
		if (typeof issued.accessToken !== 'string' || !issued.accessToken) throw new Error('Genuinely issued token missing');
		const token = issued.accessToken, authenticated = await f.authenticator.authenticateAccessToken(token); assert.ok(authenticated);
		assert.equal(authenticated.principal.membershipId, 'membership');
		const rest = CONTROL_PLANE_OPERATIONS.providers.leaveMembership.descriptor.rest; assert.ok(rest); assert.equal(rest.method, 'POST');
		const leaveKey = 'original-membership-leave', revokeKey = 'original-credential-revocation';
		const leave = (key = leaveKey, bearer = token) => f.app.request(new Request(`http://localhost${rest.path}`, { method: rest.method,
			headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, 'idempotency-key': key }, body: '{}' }));
		// Original service/repository with supplied operator actor, NOT operator HTTP.
		const revoke = (key = revokeKey, team = 'team', member = 'membership', credential = 'token-credential') =>
			f.authenticator.revokeCredential(team, member, credential, 'supplied-operator', key);
		const state = async () => {
			const original = await f.tokenState();
			return { ...original, tokens: original.tokens.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'last_used_at' && key !== 'updated_at'))),
				authorizations: (await f.query('SELECT * FROM capacity_provider_credential_issuance_authorizations ORDER BY id')).rows };
		};
		assert.ok(Date.now() < Date.parse(f.attempt.deadline), 'Original three-second revocation authority elapsed in setup');
		return { ...f, token, authenticated, leave, leaveKey, revoke, revokeKey, revocationState: state };
	} catch (error) { await f.close(); throw error; }
}
