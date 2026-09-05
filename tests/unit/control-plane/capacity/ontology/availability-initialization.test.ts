import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilityOfferDigest, CORE_CAPABILITY_DEFINITIONS, type CapabilityOffer } from '@treeseed/sdk/capacity-provider';
import type { CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';
import { AvailabilitySessionRepository } from '../../../../../src/api/capacity/repositories/accounts/availability-session.ts';
import { AvailabilitySessionService } from '../../../../../src/api/capacity/services/accounts/availability-session-service.ts';

const principal = { membershipId: 'membership-test', teamId: 'team-test', capacityProviderId: 'provider-test' };
const definition = CORE_CAPABILITY_DEFINITIONS[0]!;
function input(invalidDigest = false) {
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
	return { expectedSequence: 1, offers: [{ offer: { ...material, offerDigest: capabilityOfferDigest(material) }, status: 'available', laneIds: ['communication', 'platform', 'workday'], maxConcurrentWorkers: 1 }],
		lanes: ['communication', 'platform', 'workday'].map((purpose) => ({ id: purpose, purpose, maxConcurrentWorkers: 1 })) };
}

function coldStore() {
	const definitions = new Map<string, Record<string, unknown>>();
	const batch = vi.fn(async (operations: Array<{ query: string; params?: unknown[] }>) => {
		for (const operation of operations) if (operation.query.startsWith('INSERT INTO capability_definitions')) {
			const [id, version, digest, , , status, json] = operation.params!;
			definitions.set(`${id}@${version}`, { definition_digest: digest, status, definition_json: json });
		}
	});
	const store = { ensureInitialized: vi.fn(async () => {}), batch,
		first: vi.fn(async (query: string, params: unknown[] = []) => {
			if (query.includes('SELECT membership.id')) return { id: principal.membershipId };
			if (query.includes('FROM capability_definitions')) return definitions.get(`${params[0]}@${params[1]}`) ?? null;
			return null;
		}), run: vi.fn(), all: vi.fn() } as unknown as CapacityGovernanceDatabase;
	return { store, batch };
}

afterEach(() => vi.restoreAllMocks());
describe('availability initializes its ontology without a catalog read', () => {
	it.each(['open', 'refresh'] as const)('%s initializes a cold catalog before validating offers', async (operation) => {
		const { store, batch } = coldStore();
		const write = vi.spyOn(AvailabilitySessionRepository.prototype, operation).mockResolvedValue(null);
		const service = new AvailabilitySessionService(store);
		const invoke = () => operation === 'open' ? service.open(principal, input()) : service.refresh(principal, 'session-test', input());
		await invoke(); await invoke();
		expect(write).toHaveBeenCalledTimes(2);
		expect(batch).toHaveBeenCalledTimes(1);
	});
	it('still rejects an unknown capability digest after initializing', async () => {
		const { store } = coldStore();
		const write = vi.spyOn(AvailabilitySessionRepository.prototype, 'open').mockResolvedValue(null);
		await expect(new AvailabilitySessionService(store).open(principal, input(true))).rejects.toMatchObject({ code: 'provider_capability_offer_unknown' });
		expect(write).not.toHaveBeenCalled();
	});
});
