import type { CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import type { ProviderAvailabilitySessionStatus } from '@treeseed/sdk/capacity-provider/contracts';
import { randomUUID } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { AvailabilitySessionRepository,type AvailabilitySessionWrite } from '../../repositories/accounts/availability-session.ts';
import { upsertCapacityExecutionProviderOperations } from '../../repositories/capacity/providers/execution-provider.ts';
import { capabilityOfferDigest, capabilityOfferSchema, type CapabilityDefinition } from '@treeseed/sdk/capacity-provider';

type JsonRecord = Record<string, unknown>;
export interface ProviderAvailabilityPrincipal { membershipId: string; teamId: string; capacityProviderId: string; }

function object(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function objects(value: unknown): JsonRecord[] { return Array.isArray(value) ? value.filter((entry): entry is JsonRecord => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry))) : []; }
function strings(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.map(String).map((entry) => entry.trim()).filter(Boolean))] : []; }
function isMinimumAssignmentDuration(value: unknown) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (!Number.isInteger(candidate.amount) || Number(candidate.amount) < 1) return false;
	if (candidate.unit === 'seconds') return true;
	if (candidate.unit !== 'business-days' || !candidate.calendar || typeof candidate.calendar !== 'object' || Array.isArray(candidate.calendar)) return false;
	const calendar = candidate.calendar as Record<string, unknown>;
	try { new Intl.DateTimeFormat('en', { timeZone: String(calendar.timeZone ?? '') }).format(); } catch { return false; }
	const weekdays = calendar.weekdays ?? [1, 2, 3, 4, 5]; const holidays = calendar.holidayDates ?? [];
	return Array.isArray(weekdays) && weekdays.length > 0 && weekdays.every((day) => Number.isInteger(day) && Number(day) >= 1 && Number(day) <= 7)
		&& new Set(weekdays).size === weekdays.length && Array.isArray(holidays) && holidays.every((date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(date));
}
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

export class AvailabilitySessionService {
	private readonly repository: AvailabilitySessionRepository;
	constructor(private readonly database: CapacityGovernanceDatabase) { this.repository = new AvailabilitySessionRepository(database); }

	get(teamId: string, sessionId: string) { return this.repository.get(teamId, sessionId); }
	listPage(teamId: string, filters: { providerId?: string | null; status?: ProviderAvailabilitySessionStatus | null; limit: number; cursor: CapacityPageCursor | null }) { return this.repository.listPage(teamId, filters); }

	async open(principal: ProviderAvailabilityPrincipal, input: JsonRecord) {
		await this.assertMembership(principal);
		await this.validateOfferReferences(principal, input);
		const now = new Date().toISOString();
		const write = this.write(principal, randomUUID(), 1, input, now);
		return this.repository.open(write, upsertCapacityExecutionProviderOperations({ providerId: principal.capacityProviderId, executionProviders: write.executionProviders, providerNativeLimits: write.nativeLimits, createdAt: now }));
	}

	async refresh(principal: ProviderAvailabilityPrincipal, sessionId: string, input: JsonRecord) {
		await this.assertMembership(principal);
		await this.validateOfferReferences(principal, input);
		const expectedSequence = Number(input.expectedSequence);
		if (!Number.isInteger(expectedSequence) || expectedSequence < 1) throw new CapacityGovernanceError('provider_availability_sequence_required', 'expectedSequence must be a positive integer.', 400);
		const now = new Date().toISOString();
		const write = this.write(principal, sessionId, expectedSequence, input, now);
		const guard = { sessionId, membershipId: principal.membershipId, teamId: principal.teamId, expectedSequence };
		return this.repository.refresh(write, expectedSequence, upsertCapacityExecutionProviderOperations({ providerId: principal.capacityProviderId, executionProviders: write.executionProviders, providerNativeLimits: write.nativeLimits, createdAt: now, availabilityGuard: guard }));
	}

	async close(principal: ProviderAvailabilityPrincipal, sessionId: string) {
		await this.assertMembership(principal);
		const existing = await this.repository.get(principal.teamId, sessionId);
		if (!existing || existing.membershipId !== principal.membershipId || existing.providerId !== principal.capacityProviderId) return null;
		if (existing.status === 'closed' || existing.status === 'expired') return existing;
		if (existing.status !== 'open' && existing.status !== 'draining') throw new CapacityGovernanceError('provider_availability_close_conflict', `Availability session in ${existing.status} state cannot be closed.`, 409, { sessionId });
		return this.repository.close(principal.teamId, principal.membershipId, sessionId);
	}

	private async assertMembership(principal: ProviderAvailabilityPrincipal) {
		if (!principal.membershipId) throw new CapacityGovernanceError('provider_membership_required', 'Provider availability requires an approved membership access token.', 401);
		const membership = await this.database.first(`SELECT membership.id FROM capacity_provider_team_memberships membership JOIN capacity_providers provider ON provider.id = membership.capacity_provider_id WHERE membership.id = ? AND membership.team_id = ? AND membership.capacity_provider_id = ? AND membership.status = 'approved' AND provider.status = 'active' LIMIT 1`, [principal.membershipId, principal.teamId, principal.capacityProviderId]);
		if (!membership) throw new CapacityGovernanceError('provider_membership_not_approved', 'Provider membership is not approved and active.', 403);
	}

	private async validateOfferReferences(principal: ProviderAvailabilityPrincipal, input: JsonRecord) {
		for (const [index, route] of objects(input.offers).entries()) {
			const parsed = capabilityOfferSchema.safeParse(route.offer);
			if (!parsed.success) throw new CapacityGovernanceError('provider_capability_offer_invalid', `Capability offer ${index} is invalid.`, 400, { issues: parsed.error.issues });
			const { offerDigest, ...material } = parsed.data;
			if (capabilityOfferDigest(material) !== offerDigest) throw new CapacityGovernanceError('provider_capability_offer_digest_mismatch', `Capability offer ${index} digest is invalid.`, 400);
			for (const reference of parsed.data.capabilities) {
				const core = await this.database.first(`SELECT definition_digest,status,definition_json FROM capability_definitions WHERE capability_id=? AND version=? ORDER BY generation DESC LIMIT 1`, [reference.id, reference.version]);
				const extension = core ? null : await this.database.first(`SELECT definition_digest,status,definition_json FROM provider_capability_proposals WHERE capacity_provider_id=? AND capability_id=? AND version=? ORDER BY created_at DESC LIMIT 1`, [principal.capacityProviderId, reference.id, reference.version]);
				const definition = core ?? extension;
				if (!definition || definition.status === 'revoked' || String(definition.definition_digest) !== reference.digest) throw new CapacityGovernanceError('provider_capability_offer_unknown', `Offer references unavailable capability ${reference.id}@${reference.version}.`, 409);
				const conformance = parsed.data.conformance.find((entry) => entry.capability.id === reference.id && entry.capability.version === reference.version && entry.capability.digest === reference.digest);
				if (!conformance || conformance.providerId !== principal.capacityProviderId || conformance.status !== 'passed' || (conformance.expiresAt && Date.parse(conformance.expiresAt) <= Date.now())) throw new CapacityGovernanceError('provider_capability_conformance_invalid', `Offer lacks current provider conformance for ${reference.id}@${reference.version}.`, 409);
				const definitionValue = (typeof definition.definition_json === 'string' ? JSON.parse(definition.definition_json) : definition.definition_json) as CapabilityDefinition;
				const tiers = ['signed-attestation', 'automated-suite', 'reviewed-certification'];
				if (tiers.indexOf(conformance.tier) < tiers.indexOf(definitionValue.qualificationTier)) throw new CapacityGovernanceError('provider_capability_qualification_insufficient', `Offer qualification is below the required tier for ${reference.id}.`, 409);
			}
		}
	}

	private write(principal: ProviderAvailabilityPrincipal, id: string, sequence: number, input: JsonRecord, now: string): AvailabilitySessionWrite {
		const ttlSeconds = ttl(input.ttlSeconds);
		const expiresAt = new Date(Date.parse(now) + ttlSeconds * 1000).toISOString();
		const availableFrom = timestamp(input.availableFrom, now);
		const availableUntil = input.availableUntil == null ? null : timestamp(input.availableUntil, expiresAt);
		if (availableUntil && Date.parse(availableUntil) <= Date.parse(availableFrom)) throw new CapacityGovernanceError('provider_availability_window_invalid', 'availableUntil must be after availableFrom.', 400);
		if ('executionProviders' in input || 'execution_providers' in input) throw new CapacityGovernanceError('provider_availability_legacy_shape', 'Availability must use provider v3 adapters and lanes.', 400);
		const offerRoutes = objects(input.offers);
		const adapters = offerRoutes.length ? offerRoutes.map((route) => {
			const offer = object(route.offer); const offerId = String(offer.offerId);
			return { id: `offer:${offerId}`, status: route.status, laneIds: route.laneIds, maxConcurrentWorkers: route.maxConcurrentWorkers,
				offers: [offer], capabilities: objects(offer.capabilities).map((reference) => String(reference.id)), metadata: { opaqueOfferRoute: true } };
		}) : objects(input.adapters);
		const lanes = objects(input.lanes);
		if (!adapters.length || adapters.some((entry) => typeof entry.id !== 'string' || !entry.id.trim())) throw new CapacityGovernanceError('provider_adapter_invalid', 'Availability requires at least one routed capability offer or legacy execution adapter.', 400);
		if (lanes.length !== 3 || new Set(lanes.map((entry) => entry.purpose)).size !== 3 || !['communication', 'platform', 'workday'].every((purpose) => lanes.some((entry) => entry.purpose === purpose))) throw new CapacityGovernanceError('provider_lanes_invalid', 'Availability requires exactly the communication, platform, and workday lanes.', 400);
		if (lanes.some((entry) => entry.minimumAssignmentDuration !== undefined && !isMinimumAssignmentDuration(entry.minimumAssignmentDuration))) throw new CapacityGovernanceError('provider_lane_minimum_duration_invalid', 'Every advertised minimum assignment duration must satisfy the SDK contract.', 400);
		const executionProviders = adapters.map((adapter) => ({
			...adapter,
			status: adapter.status === 'available' ? 'active' : adapter.status,
			maxConcurrentRunners: adapter.maxConcurrentWorkers,
			lanes: lanes.filter((lane) => Array.isArray(adapter.laneIds) && adapter.laneIds.includes(lane.id)).map((lane) => ({ ...lane, maxConcurrentRunners: lane.maxConcurrentWorkers })),
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
