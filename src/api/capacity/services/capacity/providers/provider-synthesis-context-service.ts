import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { decodeDurableJsonArray } from '../../../durable-json.ts';
import type { MinimumAssignmentDuration } from '@treeseed/sdk/capacity-provider/contracts';
import type { CapabilityOffer } from '@treeseed/sdk/capacity-provider';
import { capacitySupplyCandidateStatus } from '../../../policy/supply-selection.ts';
import { providerCapabilityCompatibility, usesLegacyCapabilityCompatibility } from '../../../policy/capability-compatibility.ts';

type Row = Record<string, unknown>;

export interface ProviderSynthesisPrincipal {
	membershipId: string;
	teamId: string;
	capacityProviderId: string;
}

export interface ProviderSynthesisContextInput {
	sessionId?: string | null;
	providerSessionId?: string | null;
	environment?: string | null;
	now?: string;
}

export interface ProviderSynthesisContext {
	provider: { id: string; status: string };
	session: {
		id: string;
		membershipId: string;
		teamId: string;
		providerId: string;
		environment: string | null;
		status: string;
		availableFrom: string | null;
		availableUntil: string | null;
		expiresAt: string | null;
	};
	executionProviders: ProviderSynthesisExecutionProvider[];
	now: string;
	environment: string | null;
}

export interface ProviderSynthesisExecutionProvider {
	id: string;
	status: string;
	capabilities: string[];
	offers: CapabilityOffer[];
	legacyCapabilityBridge: boolean;
	reliability?: number;
	pressure?: 'idle' | 'normal' | 'busy' | 'throttled' | 'exhausted';
	availableConcurrency?: number;
	maxConcurrentRunners: number;
	estimatedCost?: number | null;
	minimumAssignmentDuration?: MinimumAssignmentDuration;
	lanes: Array<{
		id: string;
		purpose: 'communication' | 'platform' | 'workday';
		maxConcurrentRunners: number;
		priority: number;
		reservedConcurrentWorkers: number;
		borrowWhenIdle: boolean;
		lendWhenIdle: boolean;
		queueLimit: number;
		capabilities: string[];
		minimumAssignmentDuration?: MinimumAssignmentDuration;
	}>;
}

function text(value: unknown): string | null {
	return typeof value === 'string' && value ? value : null;
}

function requireValidTimestamp(value: string, field: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) {
		throw new CapacityGovernanceError('provider_synthesis_time_invalid', `${field} must be an ISO timestamp.`, 400, { field });
	}
	return parsed;
}

function sessionContext(row: Row) {
	return {
		id: String(row.id),
		membershipId: String(row.membership_id),
		teamId: String(row.team_id),
		providerId: String(row.capacity_provider_id),
		environment: text(row.environment),
		status: String(row.status),
		availableFrom: text(row.available_from ?? row.opened_at),
		availableUntil: text(row.available_until),
		expiresAt: text(row.expires_at),
	};
}

function executionProviders(row: Row): ProviderSynthesisExecutionProvider[] {
	return decodeDurableJsonArray<Row>(row.execution_providers_json, {
		owner: 'provider availability session', ownerId: text(row.id), column: 'execution_providers_json',
	}).map((provider) => ({
		id: String(provider.id ?? '').trim(),
		status: capacitySupplyCandidateStatus(provider.status),
		capabilities: providerCapabilityCompatibility(provider.capabilities),
		offers: Array.isArray(provider.offers) ? provider.offers as CapabilityOffer[] : [],
		legacyCapabilityBridge: !Array.isArray(provider.offers) && usesLegacyCapabilityCompatibility(provider.capabilities),
		reliability: Number.isFinite(Number(provider.reliability)) ? Math.max(0, Math.min(1, Number(provider.reliability))) : 1,
		pressure: ['idle', 'normal', 'busy', 'throttled', 'exhausted'].includes(String(provider.pressure)) ? provider.pressure as ProviderSynthesisExecutionProvider['pressure'] : 'normal',
		availableConcurrency: Number.isInteger(Number(provider.availableConcurrency)) ? Math.max(0, Number(provider.availableConcurrency)) : 1,
		maxConcurrentRunners: Math.max(1, Number(provider.maxConcurrentRunners ?? 1)),
		estimatedCost: Number.isFinite(Number(provider.estimatedCost)) ? Number(provider.estimatedCost) : null,
		...(provider.minimumAssignmentDuration ? { minimumAssignmentDuration: provider.minimumAssignmentDuration as unknown as MinimumAssignmentDuration } : {}),
		lanes: Array.isArray(provider.lanes) ? provider.lanes.map((value) => value as Row).flatMap((lane) => {
			const id = String(lane.id ?? '').trim();
			const purpose = ['communication', 'platform', 'workday'].includes(String(lane.purpose)) ? lane.purpose as 'communication' | 'platform' | 'workday' : null;
			return id && purpose ? [{ id, purpose, maxConcurrentRunners: Math.max(1, Number(lane.maxConcurrentRunners ?? 1)),
				priority: Number(lane.priority ?? 0), reservedConcurrentWorkers: Math.max(0, Number(lane.reservedConcurrentWorkers ?? 0)),
				borrowWhenIdle: Boolean(lane.borrowWhenIdle), lendWhenIdle: Boolean(lane.lendWhenIdle), queueLimit: Math.max(0, Number(lane.queueLimit ?? 0)),
				capabilities: providerCapabilityCompatibility(lane.capabilities),
				...(lane.minimumAssignmentDuration ? { minimumAssignmentDuration: lane.minimumAssignmentDuration as unknown as MinimumAssignmentDuration } : {}) }] : [];
		}) : [],
	})).filter((provider) => provider.id);
}

export async function resolveProviderSynthesisContext(
	database: CapacityGovernanceDatabase,
	principal: ProviderSynthesisPrincipal,
	input: ProviderSynthesisContextInput = {},
): Promise<ProviderSynthesisContext> {
	await database.ensureInitialized();
	const authority = await database.first(
		`SELECT provider.id AS provider_id, provider.status AS provider_status
		 FROM capacity_provider_team_memberships membership
		 JOIN capacity_providers provider ON provider.id = membership.capacity_provider_id
		 WHERE membership.id = ? AND membership.team_id = ? AND membership.capacity_provider_id = ?
		   AND membership.status = 'approved' AND provider.status = 'active'
		 LIMIT 1`,
		[principal.membershipId, principal.teamId, principal.capacityProviderId],
	);
	if (!authority) {
		throw new CapacityGovernanceError(
			'provider_synthesis_authority_invalid',
			'Provider synthesis requires an approved membership and active provider identity.',
			403,
		);
	}
	const requestedSessionId = input.sessionId ?? input.providerSessionId ?? null;
	const row = requestedSessionId
		? await database.first(
			`SELECT * FROM capacity_provider_availability_sessions
			 WHERE id = ? AND membership_id = ? AND team_id = ? AND capacity_provider_id = ? LIMIT 1`,
			[requestedSessionId, principal.membershipId, principal.teamId, principal.capacityProviderId],
		)
		: await database.first(
			`SELECT * FROM capacity_provider_availability_sessions
			 WHERE membership_id = ? AND team_id = ? AND capacity_provider_id = ? AND status = 'open'
			 ORDER BY refreshed_at DESC, created_at DESC LIMIT 1`,
			[principal.membershipId, principal.teamId, principal.capacityProviderId],
		);
	if (!row) {
		throw new CapacityGovernanceError(
			requestedSessionId ? 'provider_synthesis_session_not_found' : 'provider_synthesis_session_required',
			requestedSessionId
				? 'The requested provider availability session does not exist in this membership scope.'
				: 'Provider synthesis requires an open availability session.',
			requestedSessionId ? 404 : 409,
			requestedSessionId ? { sessionId: requestedSessionId } : undefined,
		);
	}
	const session = sessionContext(row);
	if (session.status !== 'open' || row.closed_at) {
		throw new CapacityGovernanceError('provider_synthesis_session_not_open', 'Provider synthesis requires an open availability session.', 409, { sessionId: session.id });
	}
	const now = input.now ?? new Date().toISOString();
	const nowMs = requireValidTimestamp(now, 'now');
	if (session.availableFrom && requireValidTimestamp(session.availableFrom, 'availableFrom') > nowMs) {
		throw new CapacityGovernanceError('provider_synthesis_window_not_started', 'Provider availability has not started.', 409, { sessionId: session.id });
	}
	const availableUntil = session.availableUntil ?? session.expiresAt;
	if (availableUntil && requireValidTimestamp(availableUntil, 'availableUntil') <= nowMs) {
		throw new CapacityGovernanceError('provider_synthesis_window_expired', 'Provider availability has expired.', 409, { sessionId: session.id });
	}
	if (input.environment && session.environment && input.environment !== session.environment) {
		throw new CapacityGovernanceError('provider_synthesis_environment_mismatch', 'Provider session environment does not match the synthesis request.', 409, {
			sessionId: session.id,
			requestedEnvironment: input.environment,
			sessionEnvironment: session.environment,
		});
	}
	return {
		provider: { id: String(authority.provider_id), status: String(authority.provider_status) },
		session,
		executionProviders: executionProviders(row),
		now,
		environment: input.environment ?? session.environment,
	};
}
