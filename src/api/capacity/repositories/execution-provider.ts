import type { CapacityExecutionProvider } from '@treeseed/sdk/capacity-provider/contracts';
import type { CapacityDatabaseOperation, CapacityGovernanceDatabase } from '../database.ts';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? [...new Set(value.map((entry) => String(entry ?? '').trim()).filter(Boolean))]
		: [];
}

function positiveInteger(value: unknown, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function upsertCapacityExecutionProviderOperations(input: {
	providerId: string;
	executionProviders: unknown;
	providerNativeLimits?: unknown;
	createdAt: string;
	availabilityGuard?: { sessionId: string; membershipId: string; teamId: string; expectedSequence: number };
}): CapacityDatabaseOperation[] {
	if (!Array.isArray(input.executionProviders)) return [];
	const providerNativeLimits = record(input.providerNativeLimits);
	const seen = new Set<string>();
	return input.executionProviders.flatMap((value) => {
		const entry = record(value);
		const id = String(entry.id ?? '').trim();
		if (!id || seen.has(id)) return [];
		seen.add(id);
		const adapter = String(entry.adapter ?? entry.kind ?? id).trim();
		const displayName = String(entry.displayName ?? entry.name ?? id).trim();
		const status = ['active', 'degraded', 'unavailable', 'revoked'].includes(String(entry.status))
			? String(entry.status)
			: 'active';
		const nativeLimits = entry.nativeLimits ?? entry.limits ?? providerNativeLimits;
		const guardClause = input.availabilityGuard
			? ` WHERE EXISTS (SELECT 1 FROM capacity_provider_availability_sessions WHERE id = ? AND membership_id = ? AND team_id = ? AND sequence = ? AND status = 'open')`
			: '';
		const guardParams = input.availabilityGuard
			? [input.availabilityGuard.sessionId, input.availabilityGuard.membershipId, input.availabilityGuard.teamId, input.availabilityGuard.expectedSequence]
			: [];
		const executionProviderOperation: CapacityDatabaseOperation = {
			query: `INSERT INTO capacity_execution_providers (
				capacity_provider_id, id, display_name, adapter, status, capabilities_json,
				native_unit, quota_visibility, max_concurrent_runners, native_limits_json,
				latest_observation_json, metadata_json, created_at, updated_at
			) SELECT ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS integer), ?, ?, ?, ?, ?${guardClause}
			ON CONFLICT (capacity_provider_id, id) DO UPDATE SET
				display_name = EXCLUDED.display_name,
				adapter = EXCLUDED.adapter,
				status = EXCLUDED.status,
				capabilities_json = EXCLUDED.capabilities_json,
				native_unit = EXCLUDED.native_unit,
				quota_visibility = EXCLUDED.quota_visibility,
				max_concurrent_runners = EXCLUDED.max_concurrent_runners,
				native_limits_json = EXCLUDED.native_limits_json,
				latest_observation_json = EXCLUDED.latest_observation_json,
				metadata_json = EXCLUDED.metadata_json,
				updated_at = EXCLUDED.updated_at`,
			params: [
				input.providerId,
				id,
				displayName,
				adapter,
				status,
				JSON.stringify(strings(entry.capabilities)),
				String(entry.nativeUnit ?? 'assignment'),
				String(entry.quotaVisibility ?? 'opaque'),
				positiveInteger(entry.maxConcurrentRunners ?? entry.maxConcurrentWorkers ?? providerNativeLimits.maxConcurrentRunners, 1),
				JSON.stringify(nativeLimits ?? []),
				entry.observations || entry.observation ? JSON.stringify(entry.observations ?? entry.observation) : null,
				JSON.stringify(record(entry.metadata)),
				input.createdAt,
				input.createdAt,
				...guardParams,
			],
		};
		const laneOperations = Array.isArray(entry.lanes) ? entry.lanes.flatMap((laneValue) => {
			const lane = record(laneValue);
			const laneId = String(lane.id ?? '').trim();
			if (!laneId) return [];
			const laneStatus = ['active', 'paused', 'degraded', 'revoked'].includes(String(lane.status))
				? String(lane.status)
				: 'active';
			return [{
				query: `INSERT INTO capacity_provider_lanes (
					capacity_provider_id, id, execution_provider_id, display_name, status,
					capabilities_json, max_concurrent_runners, native_limits_json,
					metadata_json, created_at, updated_at
				) SELECT ?, ?, ?, ?, ?, ?, CAST(? AS integer), ?, ?, ?, ?${guardClause}
				ON CONFLICT (capacity_provider_id, id) DO UPDATE SET
					execution_provider_id = EXCLUDED.execution_provider_id,
					display_name = EXCLUDED.display_name,
					status = EXCLUDED.status,
					capabilities_json = EXCLUDED.capabilities_json,
					max_concurrent_runners = EXCLUDED.max_concurrent_runners,
					native_limits_json = EXCLUDED.native_limits_json,
					metadata_json = EXCLUDED.metadata_json,
					updated_at = EXCLUDED.updated_at`,
				params: [
					input.providerId,
					laneId,
					id,
					String(lane.displayName ?? lane.name ?? laneId),
					laneStatus,
					JSON.stringify(strings(lane.capabilities)),
					positiveInteger(lane.maxConcurrentRunners, 1),
					JSON.stringify(lane.nativeLimits ?? []),
					JSON.stringify(record(lane.metadata)),
					input.createdAt,
					input.createdAt,
					...guardParams,
				],
			} satisfies CapacityDatabaseOperation];
		}) : [];
		return [executionProviderOperation, ...laneOperations];
	});
}

function json<T>(value: unknown, fallback: T): T {
	if (typeof value !== 'string' || !value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

export function serializeCapacityExecutionProvider(row: Record<string, unknown>): CapacityExecutionProvider {
	const nativeLimits = json<CapacityExecutionProvider['nativeLimits']>(row.native_limits_json, []);
	return {
		schemaVersion: 1,
		id: String(row.id),
		providerId: String(row.capacity_provider_id),
		displayName: String(row.display_name),
		adapter: String(row.adapter),
		status: row.status as CapacityExecutionProvider['status'],
		capabilities: json<string[]>(row.capabilities_json, []),
		nativeUnit: String(row.native_unit),
		quotaVisibility: String(row.quota_visibility),
		maxConcurrentRunners: Number(row.max_concurrent_runners),
		nativeLimits: Array.isArray(nativeLimits) ? nativeLimits : [],
		latestObservation: row.latest_observation_json
			? json<CapacityExecutionProvider['latestObservation']>(row.latest_observation_json, null)
			: null,
		metadata: json<Record<string, unknown>>(row.metadata_json, {}),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export async function listCapacityExecutionProviders(
	database: CapacityGovernanceDatabase,
	providerId: string,
): Promise<CapacityExecutionProvider[]> {
	const rows = await database.all(
		`SELECT * FROM capacity_execution_providers
		 WHERE capacity_provider_id = ?
		 ORDER BY created_at ASC, id ASC`,
		[providerId],
	);
	return rows.map(serializeCapacityExecutionProvider);
}
