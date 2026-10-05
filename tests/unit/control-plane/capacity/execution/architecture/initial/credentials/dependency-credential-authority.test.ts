import { describe, expect, it } from 'vitest';
import { CapacityGovernanceError } from '../../../../../../../../src/api/capacity/database.ts';
import { verifyCapacityProviderProof } from '../../../../../../../../src/api/capacity/security.ts';
import { credentialProofInputs } from './dependency-credential-fixture.ts';
import type { CapacityGovernanceDatabase } from '../../../../../../../../src/api/capacity/database.ts';
import { CapacityAuditRepository, type CapacityAuditWrite } from '../../../../../../../../src/api/capacity/repositories/support/audit.ts';

describe('original signed credential exchange binding', () => {
	it('credential and membership audit retries preserve their original scoped identity clock metadata and failure without independent reads or rewriting another operation', async () => {
		const input: Omit<CapacityAuditWrite, 'id'> = { teamId: 'team', providerId: 'provider', membershipId: 'membership',
			actorType: 'provider-identity', actorId: 'original-fingerprint', action: 'provider-identity.rotated', resourceType: 'capacity-provider',
			resourceId: 'provider', idempotencyKey: 'original-rotation', metadata: { previousVersion: 1, identityVersion: 2 }, now: '2026-10-03T00:00:00.000Z' };
		const before = structuredClone(input), writes: Array<{ sql: string; params: unknown[] }> = [], cause = new Error('Original scoped audit interruption');
		let interrupt = true, reads = 0;
		const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined,
			first: async () => { reads++; throw new Error('Unexpected independent audit read'); }, all: async () => { reads++; throw new Error('Unexpected audit inventory read'); },
			batch: async () => { throw new Error('Unexpected replacement audit transaction'); },
			run: async (sql, params = []) => { writes.push({ sql, params: structuredClone(params) }); if (interrupt) throw cause; } };
		const audit = new CapacityAuditRepository(database), identity = 'provider:team:2';
		await expect(audit.recordOnce(input, identity)).rejects.toBe(cause); interrupt = false;
		await Promise.all([audit.recordOnce(input, identity), audit.recordOnce(input, identity)]);
		expect(writes).toHaveLength(3); expect(writes[1]).toEqual(writes[0]); expect(writes[2]).toEqual(writes[0]);
		expect(writes[0]?.params.slice(1)).toEqual(['team', 'provider', 'membership', 'provider-identity', 'original-fingerprint',
			'provider-identity.rotated', 'capacity-provider', 'provider', null, 'original-rotation', JSON.stringify(input.metadata), input.now]);
		expect(writes[0]?.sql).toContain('existing.team_id IS NOT DISTINCT FROM incoming.team_id');
		expect(writes[0]?.sql).toContain('existing.idempotency_key IS NOT DISTINCT FROM incoming.idempotency_key');
		expect(writes[0]?.sql).toContain('ON CONFLICT DO NOTHING');
		await audit.recordOnce({ ...input, teamId: 'other-team', idempotencyKey: 'next-rotation' }, 'provider:other-team:3');
		expect(writes[3]?.params[0]).not.toBe(writes[0]?.params[0]); expect(writes[3]?.params[1]).toBe('other-team');
		expect(writes[3]?.params[10]).toBe('next-rotation'); expect(reads).toBe(0); expect(input).toEqual(before);
	});
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
