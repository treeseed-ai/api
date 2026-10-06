import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilityOfferDigest, CORE_CAPABILITY_DEFINITIONS, type CapabilityOffer } from '@treeseed/sdk/capacity-provider';
import type { CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';
import { AvailabilitySessionRepository } from '../../../../../src/api/capacity/repositories/accounts/availability-session.ts';
import { AvailabilitySessionService } from '../../../../../src/api/capacity/services/accounts/availability-session-service.ts';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { canonicalOfferBuildInput, invalidQualificationOffers, signSuppliedOffer, substitutedSignedOffers } from '../execution/fixtures/assignment-attempt-fixtures.ts';

const principal = { membershipId: 'membership-test', teamId: 'team-test', capacityProviderId: 'provider-test' };
const definition = CORE_CAPABILITY_DEFINITIONS[0]!;
function input(invalidDigest = false, privateKey?: KeyObject) {
	const reference = { id: definition.id, version: definition.version, digest: invalidDigest ? `sha256:${'0'.repeat(64)}` as const : definition.digest };
	const material: Omit<CapabilityOffer, 'offerDigest'> = {
		schemaVersion: 'treeseed.capability-offer/v2', offerId: 'test-offer', capabilities: [reference],
		features: [], configurationSupport: {}, permissionClasses: [], contextModes: [], inputContracts: [], outputContracts: [], interactionModes: [],
		conformance: [{ schemaVersion: 'treeseed.capability-conformance/v1', providerId: principal.capacityProviderId, capability: reference,
			tier: 'signed-attestation', status: 'passed', evidenceDigest: definition.digest, suite: null,
			issuedAt: '2026-08-30T00:00:00.000Z', expiresAt: null, signature: { keyId: 'test-key', algorithm: 'Ed25519', value: 'synthetic' } }],
		contextCapacity: { mode: 'unbounded', measurement: null, transportPayloadBytes: 1024, measurementProvenance: { provider: 'test', implementation: 'test', version: null } },
		limits: {}, commercial: { currency: null, estimatedCost: null }, region: null, trust: [],
	};
	const unsignedOffer = { ...material, offerDigest: capabilityOfferDigest(material) };
	const offer = privateKey ? signSuppliedOffer(unsignedOffer, privateKey).offer : unsignedOffer;
	return { expectedSequence: 1, adapters: [{ id: 'adapter-test', runtimeBuild: `sha256:${'1'.repeat(64)}`, offers: [offer], capabilities: [reference.id], status: 'available', laneIds: ['communication', 'platform', 'workday'], maxConcurrentWorkers: 1 }],
		lanes: ['communication', 'platform', 'workday'].map((purpose) => ({ id: purpose, purpose, maxConcurrentWorkers: 1 })) };
}

function coldStore() {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519'), publicJwk = publicKey.export({ format: 'jwk' });
	let publicIdentityBytes: unknown = JSON.stringify(publicJwk);
	const definitions = new Map<string, Record<string, unknown>>();
	const batch = vi.fn(async (operations: Array<{ query: string; params?: unknown[] }>) => {
		for (const operation of operations) if (operation.query.startsWith('INSERT INTO capability_definitions')) {
			const [id, version, digest, , , status, json] = operation.params!;
			definitions.set(`${id}@${version}`, { definition_digest: digest, status, definition_json: json });
		}
	});
	const store = { ensureInitialized: vi.fn(async () => {}), batch,
		first: vi.fn(async (query: string, params: unknown[] = []) => {
			if (query.includes('public_jwk_json') && query.includes('capacity_providers')) return publicIdentityBytes === undefined ? null
				: { id: principal.capacityProviderId, public_jwk_json: publicIdentityBytes };
			if (query.includes('SELECT membership.id')) return { id: principal.membershipId };
			if (query.includes('FROM capability_definitions')) return definitions.get(`${params[0]}@${params[1]}`) ?? null;
			return null;
		}), run: vi.fn(), all: vi.fn() } as unknown as CapacityGovernanceDatabase;
	const query = vi.fn(async (sql: string, params: unknown[] = []) => {
		const row = await store.first(sql, params);
		return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
	});
	Object.assign(store, { db: { transaction: vi.fn(async (run: (client: unknown) => Promise<unknown>) => run({ query })) } });
	return { store, batch, query, input: (invalidDigest = false) => input(invalidDigest, privateKey), publicJwk,
		sign: (offer: CapabilityOffer) => signSuppliedOffer(offer, privateKey).offer,
		setPublicIdentity(value: unknown) { publicIdentityBytes = value; } };
}

afterEach(() => vi.restoreAllMocks());
describe('availability initializes its ontology without a catalog read', () => {
	it('enforces the declared qualification tier and unique current suite receipt even when invalid qualification is genuinely signed by the registered input key', async () => {
		const f = coldStore(), service = new AvailabilitySessionService(f.store);
		const open = vi.spyOn(AvailabilitySessionRepository.prototype, 'open').mockResolvedValue(null);
		const refresh = vi.spyOn(AvailabilitySessionRepository.prototype, 'refresh').mockResolvedValue(null);
		const now = new Date().toISOString(), automated = CORE_CAPABILITY_DEFINITIONS.find(value => value.qualificationTier === 'automated-suite');
		if (!automated) throw new Error('Original automated qualification definition required');
		const offer = canonicalOfferBuildInput(now, automated.id).providers[0]!.offers[0]!;
		offer.conformance[0]!.providerId = principal.capacityProviderId;
		offer.conformance[0]!.suite = { id: 'supplied-qualification', version: '1.0.0' };
		const original = f.input(), supplied = structuredClone(original);
		supplied.adapters[0]!.offers = [f.sign(offer)]; supplied.adapters[0]!.capabilities = [automated.id];
		const before = structuredClone(supplied), identityBefore = structuredClone(f.publicJwk);
		for (const operation of ['open', 'refresh'] as const) {
			if (operation === 'open') await service.open(principal, original); else await service.refresh(principal, 'session-test', original);
			if (operation === 'open') await service.open(principal, supplied); else await service.refresh(principal, 'session-test', supplied);
		}
		expect(open).toHaveBeenCalledTimes(2); expect(refresh).toHaveBeenCalledTimes(2); open.mockClear(); refresh.mockClear();
		const outcomes: Array<{ name: string; code: string; cause: unknown }> = [];
		for (const operation of ['open', 'refresh'] as const) for (const variant of invalidQualificationOffers(offer, now)) {
			const changed = structuredClone(supplied); changed.adapters[0]!.offers = [f.sign(variant.offer)];
			const unchanged = structuredClone(changed); let cause: unknown;
			try { if (operation === 'open') await service.open(principal, changed); else await service.refresh(principal, 'session-test', changed); }
			catch (error) { cause = error; }
			outcomes.push({ name: `${operation}:${variant.name}`, code: variant.code, cause }); expect(changed).toEqual(unchanged);
		}
		for (const outcome of outcomes) expect(outcome.cause, outcome.name).toMatchObject({ status: 409, code: outcome.code });
		expect(open).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(supplied).toEqual(before); expect(f.publicJwk).toEqual(identityBefore);
		await service.open(principal, supplied); expect(open).toHaveBeenCalledTimes(1);
		// Signed-attestation legitimately has no suite. A suite identity and
		// valid native signature are supplied UNIT inputs, not executed evidence.
	});
	it('verifies the exact advertised conformance against the registered provider key before open or refresh and denies substituted signatures without publication or input repair', async () => {
		const { store, input: supplied, publicJwk, setPublicIdentity } = coldStore(), service = new AvailabilitySessionService(store);
		const open = vi.spyOn(AvailabilitySessionRepository.prototype, 'open').mockResolvedValue(null);
		const refresh = vi.spyOn(AvailabilitySessionRepository.prototype, 'refresh').mockResolvedValue(null);
		const original = supplied(), before = structuredClone(original), identityBefore = structuredClone(publicJwk);
		await service.open(principal, original); await service.refresh(principal, 'session-test', original);
		expect(open).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1);
		open.mockClear(); refresh.mockClear();
		const foreignKey = generateKeyPairSync('ed25519').privateKey, outcomes: Array<{ name: string; cause: unknown }> = [];
		for (const operation of ['open', 'refresh'] as const) for (const variant of substitutedSignedOffers(original.adapters[0]!.offers[0]!, foreignKey)) {
			const changed = structuredClone(original); changed.adapters[0]!.offers = [variant.offer]; const immutable = structuredClone(changed);
			let cause: unknown;
			try { if (operation === 'open') await service.open(principal, changed); else await service.refresh(principal, 'session-test', changed); }
			catch (error) { cause = error; }
			outcomes.push({ name: `${operation}:${variant.name}`, cause }); expect(changed).toEqual(immutable);
		}
		for (const outcome of outcomes) expect(outcome.cause, outcome.name).toMatchObject({ status: 409, code: 'provider_capability_conformance_invalid' });
		expect(open).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
		const identities: unknown[] = [undefined, null, '', '{invalid', 'null', '{}', JSON.stringify({ ...publicJwk, kty: 'RSA' }),
			JSON.stringify({ ...publicJwk, crv: 'X25519' }), JSON.stringify({ ...publicJwk, x: '' }),
			JSON.stringify({ ...publicJwk, d: 'controlled-prohibited-private-field' })];
		const keyOutcomes: unknown[] = [];
		for (const operation of ['open', 'refresh'] as const) for (const identity of identities) {
			setPublicIdentity(identity); let cause: unknown;
			try { if (operation === 'open') await service.open(principal, original); else await service.refresh(principal, 'session-test', original); }
			catch (error) { cause = error; }
			keyOutcomes.push(cause); expect(original).toEqual(before);
		}
		for (const cause of keyOutcomes) expect(cause).toMatchObject({ status: 409, code: 'provider_capability_conformance_invalid' });
		expect(open).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
		setPublicIdentity(JSON.stringify(publicJwk));
		expect(original).toEqual(before); expect(publicJwk).toEqual(identityBefore);
		await service.open(principal, original); expect(open).toHaveBeenCalledTimes(1);
		// Native signature bytes and controlled registered-key reply, UNIT only:
		// no enrollment, qualified suite, SQL publication or managed execution.
	});
	it('rejects missing malformed mixed and duplicate offer inventories before open or refresh can publish partial supply', async () => {
		const canonical = input().adapters[0]!.offers[0]!;
		const partial = { offerId: canonical.offerId, capabilities: [{ id: definition.id }] };
		const values: unknown[] = [undefined, null, [], {}, 'offer', [null], [0], [partial],
			[canonical, null], [canonical, structuredClone(canonical)], [{ ...partial, capabilities: null }]];
		const { store } = coldStore(), service = new AvailabilitySessionService(store);
		const open = vi.spyOn(AvailabilitySessionRepository.prototype, 'open').mockResolvedValue(null);
		const refresh = vi.spyOn(AvailabilitySessionRepository.prototype, 'refresh').mockResolvedValue(null);
		const outcomes: unknown[] = [];
		for (const operation of ['open', 'refresh'] as const) for (const offers of values) {
			const supplied = input(); Object.assign(supplied.adapters[0]!, { offers }); const before = structuredClone(supplied);
			let cause: unknown;
			try {
				if (operation === 'open') await service.open(principal, supplied);
				else await service.refresh(principal, 'session-test', supplied);
			} catch (error) { cause = error; }
			outcomes.push(cause); expect(supplied).toEqual(before);
		}
		for (const cause of outcomes) expect(cause).toMatchObject({ status: 400, code: 'provider_capability_offer_invalid' });
		expect(open).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
		// Canonical-looking conformance in input() remains UNIT input, not a
		// signed provider qualification or independently executed suite.
	});
	it('derives five-slot remaining headroom from canonical adapter worker counts on open and refresh', async () => {
		const { store, input: supplied } = coldStore();
		for (const operation of ['open', 'refresh'] as const) {
			const write = vi.spyOn(AvailabilitySessionRepository.prototype, operation).mockResolvedValue(null);
			const service = new AvailabilitySessionService(store);
			for (const activeWorkers of [0, 2, 5, 6]) {
				const value = supplied();
				value.adapters[0]!.maxConcurrentWorkers = 5;
				Object.assign(value.adapters[0]!, { activeWorkers });
				if (operation === 'open') await service.open(principal, value);
				else await service.refresh(principal, 'session-test', value);
				expect(write.mock.calls.at(-1)![0].executionProviders[0]).toMatchObject({
					maxConcurrentRunners: 5, availableConcurrency: Math.max(0, 5 - activeWorkers) });
			}
			write.mockRestore();
		}
	});
	it.each(['open', 'refresh'] as const)('%s initializes a cold catalog before validating offers', async (operation) => {
		const { store, batch, input: supplied } = coldStore();
		const write = vi.spyOn(AvailabilitySessionRepository.prototype, operation).mockResolvedValue(null);
		const service = new AvailabilitySessionService(store);
		const invoke = () => operation === 'open' ? service.open(principal, supplied()) : service.refresh(principal, 'session-test', supplied());
		await invoke(); await invoke();
		expect(write).toHaveBeenCalledTimes(2);
		expect(batch).toHaveBeenCalledTimes(1);
	});
	it('locks provider-wide authority before reading accounting and writing the session', async () => {
		const { store, query, input: supplied } = coldStore();
		const write = vi.spyOn(AvailabilitySessionRepository.prototype, 'open').mockImplementation(async () => {
			expect(query.mock.calls[0]?.[0]).toContain('capacity_providers WHERE id=$1 FOR NO KEY UPDATE');
			expect(query.mock.calls.findIndex(([sql]) => sql.includes('FROM capacity_provider_availability_sessions'))).toBeGreaterThan(0);
			return null;
		});
		await new AvailabilitySessionService(store).open(principal, supplied());
		expect(write).toHaveBeenCalledOnce();
	});
	it('still rejects an unknown capability digest after initializing', async () => {
		const { store, input: supplied } = coldStore();
		const write = vi.spyOn(AvailabilitySessionRepository.prototype, 'open').mockResolvedValue(null);
		await expect(new AvailabilitySessionService(store).open(principal, supplied(true))).rejects.toMatchObject({ code: 'provider_capability_offer_unknown' });
		expect(write).not.toHaveBeenCalled();
	});
});
