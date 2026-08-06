import type { CapacityGrantStatus,CapacityGrantV2 } from '@treeseed/sdk/agent-capacity/allocation';
import { decodeDurableJsonArray,decodeDurableJsonObject } from '../../../durable-json.ts';

export function serializeCapacityGrantRow(row: Record<string, unknown>): CapacityGrantV2 {
	const context = (column: string) => ({ owner: 'capacity grant', ownerId: String(row.id ?? ''), column });
	const metadata = decodeDurableJsonObject(row.metadata_json, context('metadata_json'));
	return {
		schemaVersion: 2,
		id: String(row.id), membershipId: String(row.membership_id), teamId: String(row.team_id), providerId: String(row.capacity_provider_id), projectId: String(row.project_id), environment: String(row.environment),
		status: String(row.status) as CapacityGrantStatus,
		executionProviderIds: decodeDurableJsonArray<string>(row.execution_provider_ids_json, context('execution_provider_ids_json')),
		laneIds: decodeDurableJsonArray<string>(row.lane_ids_json, context('lane_ids_json')),
		capabilities: decodeDurableJsonArray<string>(row.capabilities_json, context('capabilities_json')),
		allowedModes: decodeDurableJsonArray<CapacityGrantV2['allowedModes'][number]>(row.allowed_modes_json, context('allowed_modes_json')),
		dailyAgentSecondsLimit: row.daily_agent_seconds_limit == null ? null : Number(row.daily_agent_seconds_limit), monthlyAgentSecondsLimit: row.monthly_agent_seconds_limit == null ? null : Number(row.monthly_agent_seconds_limit), maxConcurrentAssignments: row.max_concurrent_assignments == null ? null : Number(row.max_concurrent_assignments),
		unmetered: Number(row.unmetered ?? 0) === 1, expiresAt: row.expires_at ? String(row.expires_at) : null,
		budgetLimits: metadata.budgetLimits && typeof metadata.budgetLimits === 'object' ? metadata.budgetLimits as CapacityGrantV2['budgetLimits'] : null,
		metadata,
	};
}
