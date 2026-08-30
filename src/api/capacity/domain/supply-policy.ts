import {
	CAPACITY_SUPPLY_POLICY_CONTRACT,
	type CapacitySupplyPolicy,
} from '@treeseed/sdk/agent-capacity';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function json(value: unknown): JsonRecord {
	if (typeof value !== 'string') return record(value);
	try { return record(JSON.parse(value)); } catch { return {}; }
}

export function teamSupplyPolicy(team: JsonRecord | null): CapacitySupplyPolicy {
	const configured = record(json(team?.metadata_json ?? team?.metadata).capacitySupplyPolicy);
	const list = (key: string) => Array.isArray(configured[key]) ? (configured[key] as unknown[]).map(String) : undefined;
	return {
		contract: CAPACITY_SUPPLY_POLICY_CONTRACT,
		generation: Math.max(1, Number(configured.generation ?? 1)),
		reliabilityFloor: Math.max(0, Math.min(1, Number(configured.reliabilityFloor ?? 0))),
		maxFailovers: Math.max(0, Number(configured.maxFailovers ?? 2)),
		allowPlanningFailover: configured.allowPlanningFailover !== false,
		allowActingFailover: configured.allowActingFailover === true,
		preferredCapacityProviderIds: list('preferredCapacityProviderIds'),
		disallowedCapacityProviderIds: list('disallowedCapacityProviderIds'),
	};
}
