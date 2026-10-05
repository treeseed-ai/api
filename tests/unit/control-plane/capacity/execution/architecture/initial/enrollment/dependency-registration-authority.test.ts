import { describe, expect, it } from 'vitest';
import { CapacityGovernanceError } from '../../../../../../../../src/api/capacity/database.ts';
import type { CapacityDatabaseOperation, CapacityGovernanceDatabase } from '../../../../../../../../src/api/capacity/database.ts';
import { CapacityRegistrationSecurityRepository, type RegistrationRateBucket } from '../../../../../../../../src/api/capacity/repositories/support/registration-security.ts';
import { verifyCapacityProviderProof } from '../../../../../../../../src/api/capacity/security.ts';
import { registrationProofInputs } from './dependency-registration-fixture.ts';

describe('original signed registration authority', () => {
	it('concurrent original rate consumptions retain their own exact batch outcomes when over limit completion precedes exact limit admission', async () => {
		const dimensions: RegistrationRateBucket['dimension'][] = ['team', 'ip', 'fingerprint', 'key-generation'];
		const inputs = ['first', 'second'].map(identity => ({ buckets: dimensions.map(dimension => ({ dimension, key: dimension === 'fingerprint' ? identity : `shared-${dimension}` })), now: '2026-10-03T17:27:14.000Z', expiresAt: '2026-10-03T17:28:14.000Z', limit: 20 })), before = structuredClone(inputs);
		const observed: CapacityDatabaseOperation[][] = [], releases: Array<(value: unknown) => void> = [];
		const database: CapacityGovernanceDatabase = { ensureInitialized: async () => { throw new Error('Unexpected initialization'); }, run: async () => { throw new Error('Unexpected separate write'); },
			first: async () => { throw new Error('Unexpected separate read'); }, all: async () => { throw new Error('Unexpected separate read'); },
			batch: operations => { observed.push(structuredClone(operations)); return new Promise<unknown>(resolve => { releases.push(resolve); }); } };
		const repository = new CapacityRegistrationSecurityRepository(database), settled = [false, false], pending = inputs.map((input, index) => {
			const original = repository.consumeRegistrationRateLimits(input); void original.then(() => { settled[index] = true; }, () => { settled[index] = true; }); return original;
		});
		const outcomes = (shared: number) => [...Array.from({ length: 5 }, () => ({ results: [] })), ...dimensions.map(dimension => ({ results: [{ count: dimension === 'fingerprint' ? 1 : shared }] }))];
		try {
			expect(settled).toEqual([false, false]); expect(observed).toHaveLength(2); expect(releases).toHaveLength(2); expect(pending[0]).not.toBe(pending[1]);
			for (const [index, input] of inputs.entries()) {
				const operations = observed[index]!; expect(operations).toHaveLength(9);
				expect(operations[0]).toEqual({ query: 'DELETE FROM capacity_provider_registration_rate_limits WHERE expires_at <= ?', params: [input.now] });
				for (const [bucketIndex, bucket] of input.buckets.entries()) {
					expect(operations[bucketIndex + 1]?.params).toEqual([bucket.dimension, bucket.key, input.now, input.expiresAt, input.now]);
					expect(operations[bucketIndex + 5]).toEqual({ query: 'SELECT count FROM capacity_provider_registration_rate_limits WHERE dimension = ? AND bucket_key = ? LIMIT 1', params: [bucket.dimension, bucket.key] });
				}
			}
			const denied = outcomes(21), admitted = outcomes(20), originalObservations = structuredClone({ denied, admitted });
			releases[1]!(denied); expect(await pending[1]).toEqual(['team', 'ip', 'key-generation']); expect(settled).toEqual([false, true]);
			releases[0]!(admitted); expect(await pending[0]).toEqual([]); expect(settled).toEqual([true, true]);
			expect(await pending[1]).toEqual(['team', 'ip', 'key-generation']); expect(observed).toHaveLength(2);
			expect({ denied, admitted }).toEqual(originalObservations); expect(inputs).toEqual(before);
		} finally { for (const release of releases) release(outcomes(20)); await Promise.allSettled(pending); }
	});
	it('original rate repository rejects missing truncated malformed and coerced counter batch observations without treating them as admission or rewriting inputs', async () => {
		const dimensions: RegistrationRateBucket['dimension'][] = ['team', 'ip', 'fingerprint', 'key-generation'];
		const input = { buckets: dimensions.map(dimension => ({ dimension, key: `supplied-${dimension}` })), now: '2026-10-03T17:17:14.000Z', expiresAt: '2026-10-03T17:18:14.000Z', limit: 20 }, before = structuredClone(input);
		const complete = () => [...Array.from({ length: 5 }, () => ({ results: [] })), ...dimensions.map(() => ({ results: [{ count: 20 }] }))];
		const invalid: unknown[] = [undefined, null, {}, [], complete().slice(0, 8), [...complete(), { results: [{ count: 20 }] }]];
		for (const index of [5, 6, 7, 8]) for (const counter of [undefined, null, '', '20', true, false, [], {}, 0, -1, 1.5, NaN, Infinity, -Infinity]) {
			const rows: unknown[] = complete(); rows[index] = { results: [{ count: counter }] }; invalid.push(rows);
		}
		for (const index of [5, 6, 7, 8]) for (const entry of [undefined, null, {}, { results: [] }, { results: [{}] }, { results: [{ count: 20 }, { count: 21 }] }]) {
			const rows: unknown[] = complete(); rows[index] = entry; invalid.push(rows);
		}
		for (const result of invalid) {
			let calls = 0; const original = structuredClone(result);
			const database: CapacityGovernanceDatabase = { ensureInitialized: async () => { throw new Error('Unexpected initialization'); },
				run: async () => { throw new Error('Unexpected separate write'); }, first: async () => { throw new Error('Unexpected separate read'); }, all: async () => { throw new Error('Unexpected separate read'); },
				batch: async () => { calls++; return result; } };
			let error: unknown; try { await new CapacityRegistrationSecurityRepository(database).consumeRegistrationRateLimits(input); } catch (caught) { error = caught; }
			expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(TypeError); expect(calls).toBe(1);
			expect(result).toEqual(original); expect(input).toEqual(before);
		}
	});
	it('original rate repository admits exact limit and reports every exceeded dimension from the same batch while preserving inputs and original batch failures', async () => {
		const dimensions: RegistrationRateBucket['dimension'][] = ['team', 'ip', 'fingerprint', 'key-generation'];
		const buckets: RegistrationRateBucket[] = dimensions.map((dimension, index) => ({ dimension, key: `supplied-bucket-${index}` }));
		const input = { buckets, now: '2026-10-03T17:05:14.000Z', expiresAt: '2026-10-03T17:06:14.000Z', limit: 20 }, before = structuredClone(input);
		for (const counts of [[20, 20, 20, 20], [21, 20, 20, 20], [20, 21, 20, 20], [20, 20, 21, 20], [20, 20, 20, 21], [21, 21, 21, 21]]) {
			const observed: CapacityDatabaseOperation[][] = [];
			const database: CapacityGovernanceDatabase = {
				ensureInitialized: async () => { throw new Error('Unexpected initialization'); }, run: async () => { throw new Error('Unexpected separate write'); },
				first: async () => { throw new Error('Unexpected separate read'); }, all: async () => { throw new Error('Unexpected separate read'); },
				batch: async operations => { observed.push(structuredClone(operations)); return [...Array.from({ length: 5 }, () => ({ results: [] })), ...counts.map(count => ({ results: [{ count }] }))]; },
			};
			expect(await new CapacityRegistrationSecurityRepository(database).consumeRegistrationRateLimits(input)).toEqual(buckets.filter((_, index) => counts[index]! > 20).map(bucket => bucket.dimension));
			expect(observed).toHaveLength(1); const operations = observed[0]!; expect(operations).toHaveLength(9);
			expect(operations[0]).toEqual({ query: 'DELETE FROM capacity_provider_registration_rate_limits WHERE expires_at <= ?', params: [input.now] });
			for (const [index, bucket] of buckets.entries()) {
				expect(operations[index + 1]?.query).toMatch(/^INSERT INTO capacity_provider_registration_rate_limits /);
				expect(operations[index + 1]?.params).toEqual([bucket.dimension, bucket.key, input.now, input.expiresAt, input.now]);
				expect(operations[index + 5]).toEqual({ query: 'SELECT count FROM capacity_provider_registration_rate_limits WHERE dimension = ? AND bucket_key = ? LIMIT 1', params: [bucket.dimension, bucket.key] });
			}
			expect(input).toEqual(before);
		}
		const cause = new Error('Controlled original batch failure'); let calls = 0;
		const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined, run: async () => { throw new Error('Unexpected write'); },
			first: async () => { throw new Error('Unexpected read'); }, all: async () => { throw new Error('Unexpected read'); }, batch: async () => { calls++; throw cause; } };
		await expect(new CapacityRegistrationSecurityRepository(database).consumeRegistrationRateLimits(input)).rejects.toBe(cause);
		expect(calls).toBe(1); expect(input).toEqual(before);
	});
	it('actual registration proof binds the exact public identity name capabilities supply metadata route audience and original clock without rewriting inputs', () => {
		const f = registrationProofInputs(), input = { proof: f.proof(f.payload), publicJwk: f.publicJwk, method: 'POST', path: f.path, audience: 'http://localhost', body: f.body, now: f.now };
		const before = structuredClone(input); expect(verifyCapacityProviderProof(input)).toMatchObject({ payload: f.payload }); expect(input).toEqual(before);
	});
	it('changed registration name capabilities supply metadata identity route audience signature and exact expiry deny original verification without input rewriting', () => {
		const f = registrationProofInputs();
		for (const mode of ['name', 'capabilities', 'supply', 'metadata', 'identity', 'path', 'audience', 'signature', 'expiry'] as const) {
			const input = { proof: f.proof(f.payload), publicJwk: f.publicJwk, method: 'POST', path: f.path, audience: 'http://localhost', body: structuredClone(f.body), now: f.now };
			if (mode === 'name') input.body.displayName = 'Moved name'; if (mode === 'capabilities') input.body.capabilitySummary = ['foreign.execution'];
			if (mode === 'supply') input.body.supplyOffer.weight = 2; if (mode === 'metadata') input.body.metadata = { source: 'changed' };
			if (mode === 'identity') input.publicJwk = registrationProofInputs().publicJwk;
			if (mode === 'path') input.path = '/foreign'; if (mode === 'audience') input.audience = 'http://foreign';
			if (mode === 'signature') input.proof.signature = Buffer.alloc(64).toString('base64url'); if (mode === 'expiry') input.now = new Date(f.payload.expiresAt);
			const before = structuredClone(input); let error: unknown; try { verifyCapacityProviderProof(input); } catch (caught) { error = caught; }
			expect(error).toBeInstanceOf(CapacityGovernanceError); expect(error).toMatchObject({ status: 401 }); expect(input).toEqual(before);
		}
	});
});
