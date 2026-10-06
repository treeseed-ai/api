import { randomUUID } from 'node:crypto';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../../../../../../../../src/api/capacity/security.ts';
import { CapacityRegistrationSecurityRepository, type RegistrationRateBucket } from '../../../../../../../../src/api/capacity/repositories/support/registration-security.ts';
import { dependencyRegistration, registrationProofInputs } from './dependency-registration-fixture.ts';

async function registration(response: Response) {
	expect(response.status).toBe(200); const value: unknown = await response.json();
	if (!value || typeof value !== 'object' || !('data' in value)) throw new Error('Original registration data missing');
	return CONTROL_PLANE_OPERATIONS.providers.register.schema.output.parse(value.data);
}
function within(f: Awaited<ReturnType<typeof dependencyRegistration>>) { expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline)); }

describe('real signed public registration and original admission SQL', () => {
	it('concurrent distinct signed public registrations share the final original rate slot admitting exactly one identity while retaining denied nonce counters and immutable replay history', async () => {
		const f = await dependencyRegistration(); try {
			expect((await f.evaluate()).eligible).toBe(true); const baselineResult = await registration(await f.register()), baseline = await f.registrationState(), custody = await f.custody();
			expect(baseline.rateLimits).toHaveLength(4);
			// Only THIS fresh fixture's three common counters are supplied as 19.
			// This is not nineteen produced requests or independent PG connections.
			for (const row of baseline.rateLimits) if (row.dimension !== 'fingerprint') await f.query('UPDATE capacity_provider_registration_rate_limits SET count=19 WHERE dimension=? AND bucket_key=?', [row.dimension, row.bucket_key]);
			const before = await f.registrationState(), contenders = ['first', 'second'].map(identity => {
				const signer = registrationProofInputs(new Date(), f.attempt.deadline); return { signer, proof: signer.proof(signer.payload), options: { body: signer.body, key: `last-rate-slot-${identity}` } };
			}), original = structuredClone(contenders.map(({ proof, options }) => ({ proof, options })));
			expect(contenders[0]!.signer.payload.providerFingerprint).not.toBe(contenders[1]!.signer.payload.providerFingerprint);
			for (const row of before.rateLimits) expect(Date.parse(String(row.expires_at))).toBeGreaterThan(Date.parse(f.attempt.deadline));
			const started = Date.now(), responses = await Promise.all(contenders.map(value => f.register(value.proof, value.options))), received = Date.now(); within(f);
			expect(responses.map(response => response.status).sort((a, b) => a - b)).toEqual([200, 429]);
			const winnerIndex = responses.findIndex(response => response.status === 200), loserIndex = responses.findIndex(response => response.status === 429);
			const winner = contenders[winnerIndex]!, loser = contenders[loserIndex]!, result = await registration(responses[winnerIndex]!);
			expect(await responses[loserIndex]!.json()).toMatchObject({ status: 429, code: 'provider_registration_rate_limited', title: 'Rate limited' });
			expect(result).toMatchObject({ teamId: 'team', status: 'pending', providerFingerprint: winner.signer.payload.providerFingerprint, registrationKeyGeneration: 1, membershipId: null,
				capabilitySummary: winner.signer.body.capabilitySummary, supplyOffer: winner.signer.body.supplyOffer });
			const after = await f.registrationState(); expect(after.requests).toHaveLength(before.requests.length + 1); expect(after.accounts).toHaveLength(before.accounts.length + 1);
			expect(after.requests.find(row => row.id === result.id)).toMatchObject({ idempotency_key: winner.options.key, proof_jti: winner.signer.payload.jti, request_digest: sha256(canonicalJson(winner.signer.body)),
				created_at: result.createdAt, updated_at: result.updatedAt, expires_at: result.expiresAt });
			expect(after.accounts.find(row => row.id === result.providerId)).toMatchObject({ fingerprint: winner.signer.payload.providerFingerprint, public_jwk_json: canonicalJson(winner.signer.publicJwk), identity_version: 1, status: 'active' });
			expect(after.requests.filter(row => row.provider_fingerprint === loser.signer.payload.providerFingerprint)).toHaveLength(0);
			expect(after.accounts.filter(row => row.fingerprint === loser.signer.payload.providerFingerprint)).toHaveLength(0);
			expect(after.nonces).toHaveLength(before.nonces.length + 2); expect(after.rateLimits).toHaveLength(before.rateLimits.length + 2);
			for (const contender of contenders) {
				expect(after.nonces.filter(row => row.jti === contender.signer.payload.jti && row.provider_fingerprint === contender.signer.payload.providerFingerprint)).toHaveLength(1);
				const rows = after.rateLimits.filter(row => row.dimension === 'fingerprint' && row.bucket_key === sha256(contender.signer.payload.providerFingerprint)); expect(rows).toHaveLength(1); expect(rows[0]?.count).toBe(1);
				expect(Date.parse(String(rows[0]?.window_started_at))).toBeGreaterThanOrEqual(started); expect(Date.parse(String(rows[0]?.window_started_at))).toBeLessThanOrEqual(received);
				expect(Date.parse(String(rows[0]?.expires_at))).toBe(Date.parse(String(rows[0]?.window_started_at)) + 60000);
			}
			for (const row of before.rateLimits) {
				const current = after.rateLimits.find(value => value.dimension === row.dimension && value.bucket_key === row.bucket_key); expect(current).toBeDefined();
				if (row.dimension === 'fingerprint') expect(current).toEqual(row);
				else { expect(current?.count).toBe(21); expect({ ...current, count: row.count, updated_at: row.updated_at }).toEqual(row);
					expect(Date.parse(String(current?.updated_at))).toBeGreaterThanOrEqual(started); expect(Date.parse(String(current?.updated_at))).toBeLessThanOrEqual(received); }
			}
			expect(after.audit).toHaveLength(before.audit.length + 1); expect(after.audit.filter(row => row.action === 'provider-registration.requested' && row.resource_id === result.id)).toHaveLength(1);
			for (const key of ['requests', 'accounts', 'nonces', 'audit'] as const) for (const row of before[key]) expect(after[key]).toContainEqual(row);
			expect({ ...after, requests: before.requests, accounts: before.accounts, nonces: before.nonces, rateLimits: before.rateLimits, audit: before.audit }).toEqual(before);
			expect(await registration(await f.register())).toEqual(baselineResult); expect(await f.registrationState()).toEqual(after);
			expect(await registration(await f.register(winner.proof, winner.options))).toEqual(result); expect(await f.registrationState()).toEqual(after);
			const replay = await f.register(loser.proof, loser.options); expect(replay.status).toBe(409); expect(await replay.json()).toMatchObject({ code: 'provider_proof_replayed' }); expect(await f.registrationState()).toEqual(after); within(f);
			const retryPayload = { ...loser.signer.payload, jti: randomUUID() }, retried = await f.register(loser.signer.proof(retryPayload), loser.options);
			expect(retried.status).toBe(429); expect(await retried.json()).toMatchObject({ code: 'provider_registration_rate_limited' }); const deniedAgain = await f.registrationState();
			expect(deniedAgain.nonces).toHaveLength(after.nonces.length + 1); expect(deniedAgain.nonces.filter(row => row.jti === retryPayload.jti)).toHaveLength(1);
			for (const row of after.nonces) expect(deniedAgain.nonces).toContainEqual(row); expect(deniedAgain.rateLimits).toHaveLength(after.rateLimits.length);
			for (const row of after.rateLimits) {
				const current = deniedAgain.rateLimits.find(value => value.dimension === row.dimension && value.bucket_key === row.bucket_key);
				if (row.dimension !== 'fingerprint' || row.bucket_key === sha256(loser.signer.payload.providerFingerprint)) { expect(current?.count).toBe(Number(row.count) + 1); expect({ ...current, count: row.count, updated_at: row.updated_at }).toEqual(row); }
				else expect(current).toEqual(row);
			}
			expect({ ...deniedAgain, nonces: after.nonces, rateLimits: after.rateLimits }).toEqual(after);
			expect(contenders.map(({ proof, options }) => ({ proof, options }))).toEqual(original); expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
	it('native late rate update interruption rolls back every original bucket mutation but retains consumed proof before fresh proof same facts retry admits one new request', async () => {
		const f = await dependencyRegistration(); try {
			expect((await f.evaluate()).eligible).toBe(true); await registration(await f.register()); const before = await f.registrationState(), custody = await f.custody();
			const next = registrationProofInputs(new Date(), f.attempt.deadline), options = { body: next.body, key: 'rate-batch-recovery' }, proof = next.proof(next.payload), inputs = structuredClone({ proof, options });
			await f.db.exec(`CREATE FUNCTION interrupt_registration_rate_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.dimension='key-generation' THEN RAISE EXCEPTION 'late original rate batch interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER interrupt_registration_rate_update BEFORE UPDATE ON capacity_provider_registration_rate_limits FOR EACH ROW EXECUTE FUNCTION interrupt_registration_rate_update();`);
			const response = await f.register(proof, options); expect(response.status).toBe(500); expect(await response.json()).toMatchObject({ status: 500, code: 'operation_failed' }); within(f);
			const failed = await f.registrationState(); expect(failed.nonces).toHaveLength(before.nonces.length + 1); expect(failed.nonces.filter(row => row.jti === next.payload.jti)).toHaveLength(1);
			for (const row of before.nonces) expect(failed.nonces).toContainEqual(row);
			// This includes earlier team/IP upserts and the fresh fingerprint
			// insertion: the WHOLE original rate transaction must roll back.
			expect({ ...failed, nonces: before.nonces }).toEqual(before); expect(await f.custody()).toEqual(custody);
			await f.db.exec('DROP TRIGGER interrupt_registration_rate_update ON capacity_provider_registration_rate_limits; DROP FUNCTION interrupt_registration_rate_update();');
			const replay = await f.register(proof, options); expect(replay.status).toBe(409); expect(await replay.json()).toMatchObject({ code: 'provider_proof_replayed' }); expect(await f.registrationState()).toEqual(failed);
			const retryPayload = { ...next.payload, jti: randomUUID() }, retryProof = next.proof(retryPayload), result = await registration(await f.register(retryProof, options)), after = await f.registrationState();
			expect(result).toMatchObject({ status: 'pending', providerFingerprint: next.payload.providerFingerprint, registrationKeyGeneration: 1, membershipId: null });
			expect(after.requests).toHaveLength(before.requests.length + 1); expect(after.accounts).toHaveLength(before.accounts.length + 1); expect(after.nonces).toHaveLength(failed.nonces.length + 1);
			expect(after.requests.find(row => row.id === result.id)).toMatchObject({ idempotency_key: options.key, proof_jti: retryPayload.jti, request_digest: sha256(canonicalJson(next.body)) });
			expect(after.accounts.find(row => row.id === result.providerId)).toMatchObject({ fingerprint: next.payload.providerFingerprint, public_jwk_json: canonicalJson(next.publicJwk), identity_version: 1 });
			expect(after.nonces.filter(row => row.jti === retryPayload.jti)).toHaveLength(1); expect(after.rateLimits).toHaveLength(before.rateLimits.length + 1);
			for (const row of before.rateLimits) {
				const current = after.rateLimits.find(value => value.dimension === row.dimension && value.bucket_key === row.bucket_key); expect(current).toBeDefined();
				if (row.dimension === 'fingerprint') expect(current).toEqual(row);
				else { expect(current?.count).toBe(Number(row.count) + 1); expect({ ...current, count: row.count, updated_at: row.updated_at }).toEqual(row); }
			}
			expect(after.rateLimits.filter(row => row.dimension === 'fingerprint' && row.bucket_key === sha256(next.payload.providerFingerprint))).toHaveLength(1);
			expect(after.rateLimits.find(row => row.dimension === 'fingerprint' && row.bucket_key === sha256(next.payload.providerFingerprint))?.count).toBe(1);
			expect(after.audit).toHaveLength(before.audit.length + 1); expect(after.audit.filter(row => row.action === 'provider-registration.requested' && row.resource_id === result.id)).toHaveLength(1);
			for (const key of ['requests', 'accounts', 'audit', 'nonces'] as const) for (const row of failed[key]) expect(after[key]).toContainEqual(row);
			expect({ ...after, requests: before.requests, accounts: before.accounts, audit: before.audit, nonces: before.nonces, rateLimits: before.rateLimits }).toEqual(before);
			expect(await registration(await f.register(retryProof, options))).toEqual(result); expect(await f.registrationState()).toEqual(after);
			expect({ proof, options }).toEqual(inputs); expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
	it('native original rate repository resets before and exact expiry only retaining later buckets original windows and whole registration history across repeated consumption', async () => {
		const f = await dependencyRegistration(); try {
			expect((await f.evaluate()).eligible).toBe(true); await registration(await f.register()); const baseline = await f.registrationState(), custody = await f.custody();
			const now = new Date().toISOString(), expiry = new Date(Date.parse(now) + 60000).toISOString(), dimensions: RegistrationRateBucket['dimension'][] = ['team', 'ip', 'fingerprint', 'key-generation'];
			expect(baseline.rateLimits).toHaveLength(4); const buckets = dimensions.map(dimension => {
				const row = baseline.rateLimits.find(value => value.dimension === dimension); expect(row).toBeDefined();
				if (!row || typeof row.bucket_key !== 'string') throw new Error('Original native rate bucket identity missing'); return { dimension, key: row.bucket_key };
			});
			// Supplied rate-storage timestamps on THIS fresh DB. No fake clock,
			// changed Assignment/Lease deadline or public proof-time authority.
			for (const [index, bucket] of buckets.entries()) await f.query('UPDATE capacity_provider_registration_rate_limits SET count=20,expires_at=? WHERE dimension=? AND bucket_key=?',
				[new Date(Date.parse(now) + [-1, 0, 1, 60000][index]!).toISOString(), bucket.dimension, bucket.key]);
			const before = await f.registrationState(), input = { buckets, now, expiresAt: expiry, limit: 20 }, original = structuredClone(input), repository = new CapacityRegistrationSecurityRepository(f.store);
			for (const expectedCounts of [[1, 1, 21, 21], [2, 2, 22, 22]]) {
				expect(await repository.consumeRegistrationRateLimits(input)).toEqual(['fingerprint', 'key-generation']); const after = await f.registrationState(); expect(after.rateLimits).toHaveLength(4);
				for (const [index, bucket] of buckets.entries()) {
					const old = before.rateLimits.find(row => row.dimension === bucket.dimension && row.bucket_key === bucket.key), current = after.rateLimits.find(row => row.dimension === bucket.dimension && row.bucket_key === bucket.key); expect(old).toBeDefined(); expect(current).toBeDefined();
					expect(current?.count).toBe(expectedCounts[index]); expect(current?.updated_at).toBe(now);
					if (index < 2) expect(current).toEqual({ ...old, count: expectedCounts[index], window_started_at: now, expires_at: expiry, updated_at: now });
					else expect(current).toEqual({ ...old, count: expectedCounts[index], updated_at: now });
				}
				expect({ ...after, rateLimits: before.rateLimits }).toEqual(before); expect(input).toEqual(original); expect(await f.custody()).toEqual(custody); within(f);
			}
		} finally { await f.close(); }
	});
	it('signed public registration denies each exhausted original rate dimension retaining consumed nonce exact counters and prior request while original replay cannot consume more authority', async () => {
		for (const exhausted of ['team', 'ip', 'fingerprint', 'key-generation', 'all'] as const) {
			const f = await dependencyRegistration(); try {
				expect((await f.evaluate()).eligible).toBe(true); const original = await registration(await f.register()), custody = await f.custody();
				const baseline = await f.registrationState(); expect(baseline.rateLimits.map(row => row.dimension).sort()).toEqual(['fingerprint', 'ip', 'key-generation', 'team']);
				// Near-limit counts are explicit SQL INPUTS on THIS fresh fixture,
				// not twenty independently produced requests or operator governance.
				for (const row of baseline.rateLimits) await f.query('UPDATE capacity_provider_registration_rate_limits SET count=? WHERE dimension=? AND bucket_key=?', [exhausted === 'all' || row.dimension === exhausted ? 20 : 19, row.dimension, row.bucket_key]);
				const before = await f.registrationState(), payload = { ...f.registrationInputs.payload, jti: randomUUID() }, proof = f.registrationInputs.proof(payload), options = { key: 'new-rate-limited-admission' }, inputs = structuredClone({ proof, options });
				for (const row of before.rateLimits) expect(Date.parse(String(row.expires_at))).toBeGreaterThan(Date.parse(f.attempt.deadline));
				const started = Date.now(), response = await f.register(proof, options), received = Date.now();
				expect(response.status).toBe(429); expect(await response.json()).toMatchObject({ status: 429, code: 'provider_registration_rate_limited', title: 'Rate limited' }); within(f);
				const denied = await f.registrationState(); expect(denied.rateLimits).toHaveLength(4); expect(denied.nonces).toHaveLength(before.nonces.length + 1);
				expect(denied.nonces.filter(row => row.jti === payload.jti)).toHaveLength(1);
				for (const row of before.rateLimits) {
					const current = denied.rateLimits.find(value => value.dimension === row.dimension && value.bucket_key === row.bucket_key); expect(current).toBeDefined();
					expect(current?.count).toBe(Number(row.count) + 1); expect({ ...current, count: row.count, updated_at: row.updated_at }).toEqual(row);
					expect(typeof current?.updated_at).toBe('string'); expect(Date.parse(String(current?.updated_at))).toBeGreaterThanOrEqual(started); expect(Date.parse(String(current?.updated_at))).toBeLessThanOrEqual(received);
				}
				for (const row of before.nonces) expect(denied.nonces).toContainEqual(row);
				expect({ ...denied, nonces: before.nonces, rateLimits: before.rateLimits }).toEqual(before);
				expect((await f.register(proof, options)).status).toBe(409); expect(await f.registrationState()).toEqual(denied);
				expect(await registration(await f.register())).toEqual(original); expect(await f.registrationState()).toEqual(denied);
				expect({ proof, options }).toEqual(inputs); expect(await f.custody()).toEqual(custody); within(f);
			} finally { await f.close(); }
		}
	});
	it('actual signed public registration creates one exact pending identity request nonce rate footprint and audit without approval credential token or financial authority', async () => {
		const f = await dependencyRegistration(); try {
			expect((await f.evaluate()).eligible).toBe(true); const before = await f.registrationState(), custody = await f.custody();
			const result = await registration(await f.register()), after = await f.registrationState();
			expect(result).toMatchObject({ teamId: 'team', providerFingerprint: f.registrationInputs.payload.providerFingerprint, registrationKeyGeneration: 1, status: 'pending',
				capabilitySummary: f.registrationInputs.body.capabilitySummary, supplyOffer: f.registrationInputs.body.supplyOffer, membershipId: null });
			expect(after.requests).toHaveLength(before.requests.length + 1); expect(after.accounts).toHaveLength(before.accounts.length + 1);
			expect(after.accounts.find(row => row.id === result.providerId)).toMatchObject({ fingerprint: f.registrationInputs.payload.providerFingerprint,
				public_jwk_json: canonicalJson(f.registrationInputs.publicJwk), display_name: f.registrationInputs.body.displayName, identity_version: 1, status: 'active' });
			expect(after.requests.find(row => row.id === result.id)).toMatchObject({ request_digest: sha256(canonicalJson(f.registrationInputs.body)), proof_jti: f.registrationInputs.payload.jti, idempotency_key: f.registrationIdempotencyKey });
			expect(after.requests.find(row => row.id === result.id)).toMatchObject({ created_at: result.createdAt, updated_at: result.updatedAt, expires_at: result.expiresAt });
			expect(after.nonces.filter(row => row.jti === f.registrationInputs.payload.jti)).toHaveLength(1); expect(after.rateLimits).toHaveLength(4);
			expect(after.rateLimits.every(row => row.count === 1)).toBe(true); expect(after.audit.filter(row => row.action === 'provider-registration.requested' && row.resource_id === result.id)).toHaveLength(1);
			expect({ ...after, accounts: before.accounts, requests: before.requests, nonces: before.nonces, rateLimits: before.rateLimits, audit: before.audit }).toEqual(before);
			for (const row of before.audit) expect(after.audit).toContainEqual(row); expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
	it('missing foreign disabled malformed and changed signed public registration authority denies after a genuine positive baseline without new admission nonce rate or finance', async () => {
		for (const mode of ['missing-key', 'foreign-key', 'disabled', 'signature', 'name', 'path', 'audience', 'identity', 'missing-proof', 'invalid-offer', 'missing-offer'] as const) {
			const f = await dependencyRegistration(); try {
				await registration(await f.register()); expect((await f.evaluate()).eligible).toBe(true);
				let proof = f.registrationInputs.proof({ ...f.registrationInputs.payload, jti: randomUUID() }); const options: Parameters<typeof f.register>[1] = { key: 'negative-registration' };
				if (mode === 'missing-key') options.authorization = 'Bearer wrong-kind'; if (mode === 'foreign-key') options.registrationKey = f.secrets.issue('registration').plaintext;
				if (mode === 'disabled') await f.authenticator.setRegistrationKeyStatus('team', 'supplied-operator', 'disabled', 'disable-key');
				if (mode === 'signature') proof = { ...proof, signature: Buffer.alloc(64).toString('base64url') };
				if (mode === 'name') options.body = { displayName: 'Changed name' }; if (mode === 'identity') options.body = { publicJwk: f.publicJwk };
				if (mode === 'path') proof = f.registrationInputs.proof({ ...f.registrationInputs.payload, jti: randomUUID(), path: '/foreign' });
				if (mode === 'audience') proof = f.registrationInputs.proof({ ...f.registrationInputs.payload, jti: randomUUID(), audience: 'http://foreign' });
				if (mode === 'missing-proof') options.body = { proof: null }; if (mode === 'invalid-offer') options.body = { supplyOffer: { capabilities: ['renamed.execution'], weight: 0 } };
				if (mode === 'missing-offer') options.body = { supplyOffer: null };
				const before = await f.registrationState(), custody = await f.custody(), input = structuredClone({ proof, options }), response = await f.register(proof, options);
				expect(response.status).toBe(mode === 'disabled' ? 403 : ['invalid-offer', 'missing-offer'].includes(mode) ? 400 : 401);
				expect(await f.registrationState()).toEqual(before); expect({ proof, options }).toEqual(input); expect(await f.custody()).toEqual(custody); within(f);
			} finally { await f.close(); }
		}
	});
	it('first concurrent same key registrations and exact fresh proof replay preserve one immutable request audit and identity while changed body conflicts', async () => {
		const f = await dependencyRegistration(); try {
			const custody = await f.custody(), original = f.registrationInputs.proof(f.registrationInputs.payload);
			const responses = await Promise.all([f.register(original), f.register(f.registrationInputs.proof({ ...f.registrationInputs.payload, jti: randomUUID() }))]);
			const first = await registration(responses[0]!), second = await registration(responses[1]!); expect(second).toEqual(first);
			const before = await f.registrationState(); expect(before.requests).toHaveLength(1); expect(before.accounts.filter(row => row.id === first.providerId)).toHaveLength(1);
			expect(before.audit.filter(row => row.action === 'provider-registration.requested')).toHaveLength(1);
			expect([1, 2]).toContain(before.nonces.length); expect(before.rateLimits).toHaveLength(4); expect(before.rateLimits.every(row => row.count === before.nonces.length)).toBe(true);
			expect(await registration(await f.register(original))).toEqual(first); expect(await f.registrationState()).toEqual(before);
			expect(await registration(await f.register(f.registrationInputs.proof({ ...f.registrationInputs.payload, jti: randomUUID() })))).toEqual(first); expect(await f.registrationState()).toEqual(before);
			const body = { ...f.registrationInputs.body, displayName: 'Changed idempotent name' };
			expect((await f.register(f.registrationInputs.proof({ ...f.registrationInputs.payload, jti: randomUUID(), bodySha256: sha256(canonicalJson(body)) }), { body })).status).toBe(409);
			expect(await f.registrationState()).toEqual(before); expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
	it('concurrent actual key rotation fences old generation admission or cancels its committed pending request without granting membership credentials or finance', async () => {
		const f = await dependencyRegistration(); try {
			const before = await f.registrationState(), custody = await f.custody();
			const [response, rotated] = await Promise.all([f.register(), f.authenticator.rotateRegistrationKey('team', 'supplied-operator', 'registration-key-race')]);
			expect(rotated.generation).toBe(2); expect([200, 403]).toContain(response.status); const after = await f.registrationState();
			if (response.status === 200) { const result = await registration(response); expect(after.requests.find(row => row.id === result.id)?.status).toBe('cancelled'); }
			else { expect(after.requests).toEqual(before.requests); expect(after.accounts).toEqual(before.accounts); }
			expect([0, 1]).toContain(after.nonces.length - before.nonces.length);
			expect([0, 4]).toContain(after.rateLimits.length); expect(after.rateLimits.every(row => row.count === 1)).toBe(true);
			expect(after.audit.filter(row => row.action === 'registration-key.rotated')).toHaveLength(1);
			expect(after.audit.filter(row => row.action === 'provider-registration.requested')).toHaveLength(response.status === 200 ? 1 : 0);
			expect(after.registrationKeys.map(row => ({ generation: row.generation, status: row.status })).sort((a, b) => Number(a.generation) - Number(b.generation))).toEqual([{ generation: 1, status: 'disabled' }, { generation: 2, status: 'active' }]);
			expect((await f.register(f.registrationInputs.proof({ ...f.registrationInputs.payload, jti: randomUUID() }), { key: 'old-key-new-admission' })).status).toBe(403);
			const denied = await f.registrationState(); expect(denied).toEqual(after);
			for (const key of ['memberships', 'credentials', 'tokens', 'authorizations', 'sessions', 'invocations', 'sessionEvents'] as const) expect(after[key]).toEqual(before[key]);
			for (const row of before.audit) expect(after.audit).toContainEqual(row); expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
	it('native registration insert interruption rolls back new identity request but retains consumed nonce and rate history before fresh proof same key retry admits once', async () => {
		const f = await dependencyRegistration(); try {
			const before = await f.registrationState(), custody = await f.custody();
			await f.db.exec(`CREATE FUNCTION interrupt_registration_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'registration insert interruption'; END $$;
				CREATE TRIGGER interrupt_registration_insert BEFORE INSERT ON capacity_provider_registration_requests FOR EACH ROW EXECUTE FUNCTION interrupt_registration_insert();`);
			expect((await f.register()).status).toBe(500); const failed = await f.registrationState(); expect(failed.nonces).toHaveLength(before.nonces.length + 1);
			expect(failed.rateLimits).toHaveLength(4); expect(failed.rateLimits.every(row => row.count === 1)).toBe(true);
			expect({ ...failed, nonces: before.nonces, rateLimits: before.rateLimits }).toEqual(before);
			await f.db.exec('DROP TRIGGER interrupt_registration_insert ON capacity_provider_registration_requests; DROP FUNCTION interrupt_registration_insert();');
			expect((await f.register()).status).toBe(409); expect(await f.registrationState()).toEqual(failed);
			const result = await registration(await f.register(f.registrationInputs.proof({ ...f.registrationInputs.payload, jti: randomUUID() }))), after = await f.registrationState();
			expect(after.requests).toHaveLength(1); expect(after.requests[0]?.id).toBe(result.id); expect(after.rateLimits.every(row => row.count === 2)).toBe(true);
			expect(after.audit.filter(row => row.action === 'provider-registration.requested')).toHaveLength(1); for (const row of failed.nonces) expect(after.nonces).toContainEqual(row);
			for (const row of before.audit) expect(after.audit).toContainEqual(row); expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
	it('late registration audit interruption preserves pending request exact identity nonce and rate footprint before same key replay recovers one missing audit', async () => {
		const f = await dependencyRegistration(); try {
			const custody = await f.custody(); await f.db.exec(`CREATE FUNCTION interrupt_registration_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.action='provider-registration.requested' THEN RAISE EXCEPTION 'registration audit interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER interrupt_registration_audit BEFORE INSERT ON capacity_audit_events FOR EACH ROW EXECUTE FUNCTION interrupt_registration_audit();`);
			expect((await f.register()).status).toBe(500); const failed = await f.registrationState(); expect(failed.requests).toHaveLength(1); expect(failed.requests[0]?.status).toBe('pending');
			expect(failed.audit.filter(row => row.action === 'provider-registration.requested')).toHaveLength(0);
			await f.db.exec('DROP TRIGGER interrupt_registration_audit ON capacity_audit_events; DROP FUNCTION interrupt_registration_audit();');
			const result = await registration(await f.register()); expect(result.id).toBe(failed.requests[0]?.id); const after = await f.registrationState();
			expect(after.requests).toEqual(failed.requests); expect(after.accounts).toEqual(failed.accounts); expect(after.nonces).toEqual(failed.nonces); expect(after.rateLimits).toEqual(failed.rateLimits);
			expect(after.audit.filter(row => row.action === 'provider-registration.requested' && row.resource_id === result.id)).toHaveLength(1);
			expect({ ...after, audit: failed.audit }).toEqual(failed);
			for (const row of failed.audit) expect(after.audit).toContainEqual(row); expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
});
