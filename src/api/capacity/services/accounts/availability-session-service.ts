import { randomUUID } from 'node:crypto';
import type { ProviderAvailabilitySessionStatus } from '@treeseed/sdk/capacity-provider/contracts';
import type { CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { AvailabilitySessionRepository, type AvailabilitySessionWrite } from '../../repositories/accounts/availability-session.ts';
import { upsertCapacityExecutionProviderOperations } from '../../repositories/capacity/providers/execution-provider.ts';

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

export class AvailabilitySessionService {
	private readonly repository: AvailabilitySessionRepository;
	constructor(private readonly database: CapacityGovernanceDatabase) { this.repository = new AvailabilitySessionRepository(database); }

	get(teamId: string, sessionId: string) { return this.repository.get(teamId, sessionId); }
	listPage(teamId: string, filters: { providerId?: string | null; status?: ProviderAvailabilitySessionStatus | null; limit: number; cursor: CapacityPageCursor | null }) { return this.repository.listPage(teamId, filters); }

	async open(principal: ProviderAvailabilityPrincipal, input: JsonRecord) {
		await this.assertMembership(principal);
		const now = new Date().toISOString();
		const write = this.write(principal, randomUUID(), 1, input, now);
		return this.repository.open(write, upsertCapacityExecutionProviderOperations({ providerId: principal.capacityProviderId, executionProviders: write.executionProviders, providerNativeLimits: write.nativeLimits, createdAt: now }));
	}

	async refresh(principal: ProviderAvailabilityPrincipal, sessionId: string, input: JsonRecord) {
		await this.assertMembership(principal);
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

	private write(principal: ProviderAvailabilityPrincipal, id: string, sequence: number, input: JsonRecord, now: string): AvailabilitySessionWrite {
		const ttlSeconds = ttl(input.ttlSeconds);
		const expiresAt = new Date(Date.parse(now) + ttlSeconds * 1000).toISOString();
		const availableFrom = timestamp(input.availableFrom, now);
		const availableUntil = input.availableUntil == null ? null : timestamp(input.availableUntil, expiresAt);
		if (availableUntil && Date.parse(availableUntil) <= Date.parse(availableFrom)) throw new CapacityGovernanceError('provider_availability_window_invalid', 'availableUntil must be after availableFrom.', 400);
		const executionProviders = objects(input.executionProviders ?? input.execution_providers);
		if (executionProviders.some((entry) => typeof entry.id !== 'string' || !entry.id.trim())) throw new CapacityGovernanceError('provider_execution_provider_invalid', 'Every execution provider snapshot requires an id.', 400);
		return {
			id, membershipId: principal.membershipId, teamId: principal.teamId, providerId: principal.capacityProviderId,
			environment: typeof input.environment === 'string' ? input.environment : null, sequence, openedAt: now, refreshedAt: now, expiresAt, availableFrom, availableUntil,
			executionProviders, capabilities: strings(input.capabilities), nativeLimits: object(input.nativeLimits ?? input.native_limits),
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
