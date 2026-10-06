import { describe, expect, it } from 'vitest';
import { verifyCapacityProviderProof } from '../../../../../../../../src/api/capacity/security.ts';
import { accessTokenValiditySeconds } from '../../../../../../../../src/api/capacity/services/support/access-token-validity.ts';
import { tokenProofInputs } from './dependency-token-fixture.ts';
import { CapacityGovernanceError } from '../../../../../../../../src/api/capacity/database.ts';

describe('signed token request unit authority', () => {
	it('original proof verification binds exact key fingerprint method path audience body and original expiry without rewriting inputs', () => {
		const now = new Date('2026-10-03T13:00:00.000Z'), f = tokenProofInputs(now, new Date(now.getTime() + 3000).toISOString());
		const input = { publicJwk: f.publicJwk, proof: f.proof(), method: f.payload.method, path: f.payload.path,
			audience: f.payload.audience, body: f.body, now }; const before = structuredClone(input);
		expect(verifyCapacityProviderProof(input)).toEqual({ payload: f.payload, fingerprint: f.payload.providerFingerprint });
		expect(input).toEqual(before);
		expect(() => verifyCapacityProviderProof({ ...input, now: new Date(f.payload.expiresAt) })).toThrow();
	});
	it('changed signed body route audience key algorithm signature and malformed proof encoding deny before producing verified authority', () => {
		const now = new Date('2026-10-03T13:00:00.000Z'), f = tokenProofInputs(now, new Date(now.getTime() + 3000).toISOString());
		const input = { publicJwk: f.publicJwk, proof: f.proof(), method: f.payload.method, path: f.payload.path, audience: f.payload.audience, body: f.body, now };
		const other = tokenProofInputs(now, f.payload.expiresAt);
		for (const changed of [{ ...input, body: { ...f.body, credentialId: 'foreign' } }, { ...input, method: 'GET' },
			{ ...input, path: '/foreign' }, { ...input, audience: 'http://foreign' }, { ...input, publicJwk: other.publicJwk },
			{ ...input, proof: f.proof(f.payload, { alg: 'none', typ: 'JOSE' }) },
			{ ...input, proof: { ...input.proof, signature: Buffer.alloc(64).toString('base64url') } },
			{ ...input, proof: { ...input.proof, payload: Buffer.from('{invalid').toString('base64url') } }]) {
			const before = structuredClone(changed); let denial: unknown;
			try { verifyCapacityProviderProof(changed); } catch (error) { denial = error; }
			expect(denial).toBeInstanceOf(CapacityGovernanceError);
			if (!(denial instanceof CapacityGovernanceError)) throw new Error('Expected original proof validation denial');
			expect(denial.status).toBe(401); expect(changed).toEqual(before);
		}
	});
	it('original token validity accepts only exact integer bounds and rejects invalid numbers without changing the default', () => {
		expect(accessTokenValiditySeconds(undefined)).toBe(900); expect(accessTokenValiditySeconds(60)).toBe(60);
		expect(accessTokenValiditySeconds(7 * 24 * 60 * 60)).toBe(604800);
		for (const value of [0, -1, 59, 60.5, 604801, NaN, Infinity, -Infinity]) expect(() => accessTokenValiditySeconds(value)).toThrow();
	});
});
