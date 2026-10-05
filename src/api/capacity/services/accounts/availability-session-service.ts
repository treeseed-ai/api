import type { CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import type { ProviderAvailabilitySessionStatus } from '@treeseed/sdk/capacity-provider/contracts';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import type { CapacityDatabaseOperation, CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { AvailabilitySessionRepository,type AvailabilitySessionWrite } from '../../repositories/accounts/availability-session.ts';
import { upsertCapacityExecutionProviderOperations } from '../../repositories/capacity/providers/execution-provider.ts';
import { capabilityOfferDigest, capabilityOfferSchema, capabilityDefinitionSchema, validateCapabilityOfferQualification,
	type CapabilityDefinition } from '@treeseed/sdk/capacity-provider/contracts';
import { canonicalJson } from '../../security.ts';
import { createCapabilityOntologyService } from '../../../control-plane/repositories/capabilities/capability-ontology-service.ts';
import { decodeDurableJsonArray } from '../../durable-json.ts';
import { assertMonotonicAvailabilityAccounting } from './availability-accounting.ts';
import { capacityTransaction } from '../../transaction.ts';

type JsonRecord = Record<string, unknown>;
export interface ProviderAvailabilityPrincipal { membershipId: string; teamId: string; capacityProviderId: string; }

function object(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function objects(value: unknown): JsonRecord[] { return Array.isArray(value) ? value.filter((entry): entry is JsonRecord => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry))) : []; }
function strings(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.map(String).map((entry) => entry.trim()).filter(Boolean))] : []; }
function timestamp(value: unknown, fallback: string): string {
	if (value == null) return fallback;
	const text = String(value);
	if (!Number.isFinite(Date.parse(text))) throw new CapacityGovernanceError('provider_availability_timestamp_invalid', `Invalid availability timestamp ${text}.`, 400);
	return text;
}
function ttl(value: unknown): number {
	const parsed = value == null ? 90 : Number(value);
	if (!Number.isInteger(parsed) || parsed < 30 || parsed > 300) throw new CapacityGovernanceError('provider_availability_ttl_invalid', 'ttlSeconds must be an integer between 30 and 300.', 400);
	return parsed;
}

function reconcileSeedGrantOperations(write: AvailabilitySessionWrite): CapacityDatabaseOperation[] {
	const executionProviderIds = write.executionProviders.map((provider) => String(provider.id ?? '')).filter(Boolean);
	const lanes = write.executionProviders.flatMap((provider) => objects(provider.lanes));
	const laneIds = [...new Set(lanes.map((lane) => String(lane.id ?? '')).filter(Boolean))];
	const capabilities = [...new Set(write.executionProviders.flatMap((provider) => strings(provider.capabilities)))];
	if (!executionProviderIds.length || !laneIds.length || !capabilities.length) return [];
	return [{
		query: `UPDATE capacity_grants SET execution_provider_ids_json = ?, lane_ids_json = ?, capabilities_json = ?, updated_at = ?
			WHERE membership_id = ? AND capacity_provider_id = ? AND status IN ('planned','active','paused')
			  AND metadata_json::jsonb->>'seedName' IS NOT NULL`,
		params: [JSON.stringify(executionProviderIds), JSON.stringify(laneIds), JSON.stringify(capabilities), write.refreshedAt, write.membershipId, write.providerId],
	}];
}

export class AvailabilitySessionService {
	private readonly repository: AvailabilitySessionRepository;
	private readonly ontology: ReturnType<typeof createCapabilityOntologyService>;
	constructor(private readonly database: CapacityGovernanceDatabase) {
		this.repository = new AvailabilitySessionRepository(database);
		this.ontology = createCapabilityOntologyService(database);
	}

	get(teamId: string, sessionId: string) { return this.repository.get(teamId, sessionId); }
	listPage(teamId: string, filters: { providerId?: string | null; status?: ProviderAvailabilitySessionStatus | null; limit: number; cursor: CapacityPageCursor | null }) { return this.repository.listPage(teamId, filters); }

	async open(principal: ProviderAvailabilityPrincipal, input: JsonRecord) {
		await this.assertMembership(principal);
		await this.validateOfferReferences(principal, input);
		const now = new Date().toISOString();
		const write = this.write(principal, randomUUID(), 1, input, now);
		return this.accountingTransaction(principal, write, database => new AvailabilitySessionRepository(database).open(write,
			[...upsertCapacityExecutionProviderOperations({ providerId: principal.capacityProviderId, executionProviders: write.executionProviders, providerNativeLimits: write.nativeLimits, createdAt: now }), ...reconcileSeedGrantOperations(write)]));
	}

	async refresh(principal: ProviderAvailabilityPrincipal, sessionId: string, input: JsonRecord) {
		await this.assertMembership(principal);
		await this.validateOfferReferences(principal, input);
		const expectedSequence = Number(input.expectedSequence);
		if (!Number.isInteger(expectedSequence) || expectedSequence < 1) throw new CapacityGovernanceError('provider_availability_sequence_required', 'expectedSequence must be a positive integer.', 400);
		const now = new Date().toISOString();
		const write = this.write(principal, sessionId, expectedSequence, input, now);
		const guard = { sessionId, membershipId: principal.membershipId, teamId: principal.teamId, expectedSequence };
		return this.accountingTransaction(principal, write, database => new AvailabilitySessionRepository(database).refresh(write, expectedSequence,
			[...upsertCapacityExecutionProviderOperations({ providerId: principal.capacityProviderId, executionProviders: write.executionProviders, providerNativeLimits: write.nativeLimits, createdAt: now, availabilityGuard: guard }), ...reconcileSeedGrantOperations(write)]));
	}

	async close(principal: ProviderAvailabilityPrincipal, sessionId: string) {
		await this.assertMembership(principal);
		const existing = await this.repository.get(principal.teamId, sessionId);
		if (!existing || existing.membershipId !== principal.membershipId || existing.providerId !== principal.capacityProviderId) return null;
		if (existing.status === 'closed' || existing.status === 'expired') return existing;
		if (existing.status !== 'open' && existing.status !== 'draining') throw new CapacityGovernanceError('provider_availability_close_conflict', `Availability session in ${existing.status} state cannot be closed.`, 409, { sessionId });
		return this.repository.close(principal.teamId, principal.membershipId, sessionId);
	}

	private async accountingTransaction<T>(principal: ProviderAvailabilityPrincipal, write: AvailabilitySessionWrite,
		apply: (database: CapacityGovernanceDatabase) => Promise<T>): Promise<T> {
		return capacityTransaction(this.database, async database => {
			// Serialize accounting across memberships without blocking unchanged-key FK
			// checks held by admission/completion while publication waits on their rows.
			await database.run('SELECT id FROM capacity_providers WHERE id=? FOR NO KEY UPDATE', [write.providerId]);
			await new AvailabilitySessionService(database).assertMembership(principal);
			const previous = await database.all(`SELECT id,execution_providers_json FROM capacity_provider_availability_sessions
				WHERE capacity_provider_id=? ORDER BY refreshed_at DESC,id DESC`, [write.providerId]);
			assertMonotonicAvailabilityAccounting(write.executionProviders, previous.flatMap(row => decodeDurableJsonArray<JsonRecord>(row.execution_providers_json,
				{ owner: 'provider availability session', ownerId: String(row.id), column: 'execution_providers_json' })), write.refreshedAt);
			return apply(database);
		});
	}

	private async assertMembership(principal: ProviderAvailabilityPrincipal) {
		if (!principal.membershipId) throw new CapacityGovernanceError('provider_membership_required', 'Provider availability requires an approved membership access token.', 401);
		const membership = await this.database.first(`SELECT membership.id FROM capacity_provider_team_memberships membership JOIN capacity_providers provider ON provider.id = membership.capacity_provider_id WHERE membership.id = ? AND membership.team_id = ? AND membership.capacity_provider_id = ? AND membership.status = 'approved' AND provider.status = 'active' LIMIT 1`, [principal.membershipId, principal.teamId, principal.capacityProviderId]);
		if (!membership) throw new CapacityGovernanceError('provider_membership_not_approved', 'Provider membership is not approved and active.', 403);
	}

	private async validateOfferReferences(principal: ProviderAvailabilityPrincipal, input: JsonRecord) {
		await this.ontology.ensureInitialized();
		const adapters = input.adapters;
		if (!Array.isArray(adapters) || !adapters.length || adapters.some(adapter => !adapter || typeof adapter !== 'object'
			|| Array.isArray(adapter) || !Array.isArray(adapter.offers) || !adapter.offers.length)) {
			throw new CapacityGovernanceError('provider_capability_offer_invalid', 'Every adapter requires a complete nonempty offer inventory.', 400);
		}
		const offerIds = new Set<string>(), offers = adapters.flatMap(adapter => adapter.offers).map((offer: unknown, index) => {
			const parsed = capabilityOfferSchema.safeParse(offer);
			if (!parsed.success) throw new CapacityGovernanceError('provider_capability_offer_invalid', `Capability offer ${index} is invalid.`, 400, { issues: parsed.error.issues });
			if (offerIds.has(parsed.data.offerId)) throw new CapacityGovernanceError('provider_capability_offer_invalid', 'Offer identities must be provider-global unique.', 400);
			offerIds.add(parsed.data.offerId);
			return parsed.data;
		});
		const now = new Date();
		for (const [index, offer] of offers.entries()) {
			const { offerDigest, ...material } = offer;
			if (capabilityOfferDigest(material) !== offerDigest) throw new CapacityGovernanceError('provider_capability_offer_digest_mismatch', `Capability offer ${index} digest is invalid.`, 400);
			const definitions: CapabilityDefinition[] = [];
			for (const reference of offer.capabilities) {
				const core = await this.database.first(`SELECT definition_digest,status,definition_json FROM capability_definitions WHERE capability_id=? AND version=? ORDER BY generation DESC LIMIT 1`, [reference.id, reference.version]);
				const extension = core ? null : await this.database.first(`SELECT definition_digest,status,definition_json FROM provider_capability_proposals WHERE capacity_provider_id=? AND capability_id=? AND version=? ORDER BY created_at DESC LIMIT 1`, [principal.capacityProviderId, reference.id, reference.version]);
				const definition = core ?? extension;
				if (!definition || definition.status === 'revoked' || String(definition.definition_digest) !== reference.digest) throw new CapacityGovernanceError('provider_capability_offer_unknown', `Offer references unavailable capability ${reference.id}@${reference.version}.`, 409);
				let value: unknown;
				try { value = typeof definition.definition_json === 'string' ? JSON.parse(definition.definition_json) : definition.definition_json; }
				catch { throw new CapacityGovernanceError('provider_capability_offer_unknown', 'Capability definition bytes are malformed.', 409); }
				const parsed = capabilityDefinitionSchema.safeParse(value);
				if (!parsed.success) throw new CapacityGovernanceError('provider_capability_offer_unknown', 'Capability definition is not canonical.', 409);
				definitions.push(parsed.data);
			}
			const qualification = validateCapabilityOfferQualification(offer, { now, providerId: principal.capacityProviderId, definitions });
			if (!qualification.ok) throw new CapacityGovernanceError(qualification.diagnostics.some(entry => entry.code === 'provider_offer_qualification_insufficient')
				? 'provider_capability_qualification_insufficient' : 'provider_capability_conformance_invalid', 'Offer lacks unique current qualification at its declared tier.', 409);
		}
		try {
			const identity = await this.database.first('SELECT public_jwk_json FROM capacity_providers WHERE id=?', [principal.capacityProviderId]);
			const value: unknown = typeof identity?.public_jwk_json === 'string' ? JSON.parse(identity.public_jwk_json) : identity?.public_jwk_json;
			if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Registered public identity is required');
			const jwk = object(value);
			if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || !jwk.x
				|| (jwk.alg !== undefined && jwk.alg !== 'EdDSA') || Object.keys(jwk).some(key => !['kty', 'crv', 'x', 'alg'].includes(key))) throw new Error('Invalid registered public identity');
			const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
			const keyId = `provider-${createHash('sha256').update(jwk.x).digest('hex').slice(0, 16)}`;
			for (const offer of offers) for (const receipt of offer.conformance) {
				const bytes = Buffer.from(receipt.signature.value, 'base64url');
				const unsigned = { ...receipt, signature: { ...receipt.signature, value: '' } };
				if (receipt.signature.keyId !== keyId || bytes.length !== 64 || bytes.toString('base64url') !== receipt.signature.value
					|| !verify(null, Buffer.from(canonicalJson(unsigned)), key, bytes)) throw new Error('Invalid qualification signature');
			}
		} catch {
			throw new CapacityGovernanceError('provider_capability_conformance_invalid', 'Capability qualification is not signed by the registered provider identity.', 409);
		}
	}

	private write(principal: ProviderAvailabilityPrincipal, id: string, sequence: number, input: JsonRecord, now: string): AvailabilitySessionWrite {
		const ttlSeconds = ttl(input.ttlSeconds);
		const expiresAt = new Date(Date.parse(now) + ttlSeconds * 1000).toISOString();
		const availableFrom = timestamp(input.availableFrom, now);
		const availableUntil = input.availableUntil == null ? null : timestamp(input.availableUntil, expiresAt);
		if (availableUntil && Date.parse(availableUntil) <= Date.parse(availableFrom)) throw new CapacityGovernanceError('provider_availability_window_invalid', 'availableUntil must be after availableFrom.', 400);
		if ('executionProviders' in input || 'execution_providers' in input || 'offers' in input) throw new CapacityGovernanceError('provider_availability_legacy_shape', 'Availability must use the canonical adapters and lanes shape.', 400);
		const adapters = objects(input.adapters);
		const lanes = objects(input.lanes);
		if (!adapters.length || adapters.some((entry) => typeof entry.id !== 'string' || !entry.id.trim() || !/^sha256:[a-f0-9]{64}$/u.test(String(entry.runtimeBuild ?? '')))) throw new CapacityGovernanceError('provider_adapter_invalid', 'Availability requires at least one adapter with an exact runtime build.', 400);
		if (lanes.length !== 3 || new Set(lanes.map((entry) => entry.purpose)).size !== 3 || !['communication', 'platform', 'workday'].every((purpose) => lanes.some((entry) => entry.purpose === purpose))) throw new CapacityGovernanceError('provider_lanes_invalid', 'Availability requires exactly the communication, platform, and workday lanes.', 400);
		const executionProviders = adapters.map((adapter) => ({
			...adapter,
			status: adapter.status === 'available' ? 'active' : adapter.status,
			maxConcurrentRunners: adapter.maxConcurrentWorkers,
			availableConcurrency: Math.max(0, Number(adapter.maxConcurrentWorkers) - Number(adapter.activeWorkers ?? 0)),
			lanes: lanes.filter((lane) => Array.isArray(adapter.laneIds) && adapter.laneIds.includes(lane.id)).map((lane) => ({ ...lane,
				id: lane.id,
				maxConcurrentRunners: lane.maxConcurrentWorkers })),
		}));
		const capacity = object(input.capacity);
		return {
			id, membershipId: principal.membershipId, teamId: principal.teamId, providerId: principal.capacityProviderId,
			environment: typeof input.environment === 'string' ? input.environment : null, sequence, openedAt: now, refreshedAt: now, expiresAt, availableFrom, availableUntil,
			executionProviders, capabilities: strings(input.capabilities), nativeLimits: { ...capacity, maxConcurrentRunners: capacity.maxConcurrentWorkers },
			runnerPressure: object(input.runnerPressure ?? input.runner_pressure), constraints: object(input.constraints), metadata: object(input.metadata),
		};
	}
}

export function optionalAvailabilityStatus(value: unknown): ProviderAvailabilitySessionStatus | null {
	if (value == null || value === '') return null;
	const status = String(value) as ProviderAvailabilitySessionStatus;
	if (!['open', 'draining', 'closed', 'expired'].includes(status)) throw new CapacityGovernanceError('provider_availability_status_invalid', `Unknown availability session status ${status}.`, 400);
	return status;
}
