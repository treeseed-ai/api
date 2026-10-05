import { describe, expect, it } from 'vitest';
import { CapacityGovernanceError } from '../../../../../../../../src/api/capacity/database.ts';
import { verifyCapacityProviderProof } from '../../../../../../../../src/api/capacity/security.ts';
import { credentialProofInputs } from './dependency-credential-fixture.ts';

describe('original signed credential exchange binding', () => {
	it('actual exchange proof verification preserves the exact approved request issuance key path audience and original clock claims', () => {
		const f = credentialProofInputs(), input = { proof: f.proof, publicJwk: f.publicJwk, method: 'POST', path: f.path, audience: 'http://localhost', body: f.body, now: f.now };
		const before = structuredClone(input); expect(verifyCapacityProviderProof(input)).toMatchObject({ payload: f.payload }); expect(input).toEqual(before);
	});
	it('foreign request changed issuance key route audience and expired signed exchange authority deny without input rewriting', () => {
		const f = credentialProofInputs();
		for (const mode of ['request', 'key', 'path', 'audience', 'expiry'] as const) {
			const input = { proof: f.proof, publicJwk: f.publicJwk, method: 'POST', path: f.path, audience: 'http://localhost', body: { ...f.body }, now: f.now };
			if (mode === 'request') input.body.requestId = 'foreign'; if (mode === 'key') input.body.idempotencyKey = 'foreign-key';
			if (mode === 'path') input.path = '/foreign/credential'; if (mode === 'audience') input.audience = 'http://foreign';
			if (mode === 'expiry') input.now = new Date(f.payload.expiresAt);
			const before = structuredClone(input); let error: unknown; try { verifyCapacityProviderProof(input); } catch (caught) { error = caught; }
			expect(error).toBeInstanceOf(CapacityGovernanceError); expect(error).toMatchObject({ status: 401 }); expect(input).toEqual(before);
		}
	});
});
