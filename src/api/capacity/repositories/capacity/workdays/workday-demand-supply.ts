import { type CapacitySupplyCandidate } from '@treeseed/sdk/agent-capacity';
import { capacitySupplyCandidateStatus,selectCapacitySupply } from '../../../policy/supply-selection.ts';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { decodeDurableJsonArray,decodeDurableJsonObject } from '../../../durable-json.ts';
import { teamSupplyPolicy } from '../../../domain/supply-policy.ts';
import { providerCapabilityCompatibility } from '../../../policy/capability-compatibility.ts';

type Row = Record<string, unknown>;

function strings(value: unknown, context: { owner: string; ownerId: string; column: string }): string[] {
	return decodeDurableJsonArray<unknown>(value, context).map(String).filter(Boolean);
}

function providers(row: Row, grants: Row[], mode: string): CapacitySupplyCandidate[] {
	return decodeDurableJsonArray<Row>(row.execution_providers_json, {
		owner: 'provider availability session', ownerId: String(row.id), column: 'execution_providers_json',
	}).flatMap((provider) => grants.filter((grant) => {
		const ownerId = String(grant.id);
		const executionProviderIds = strings(grant.execution_provider_ids_json, { owner: 'capacity grant', ownerId, column: 'execution_provider_ids_json' });
		const allowedModes = strings(grant.allowed_modes_json, { owner: 'capacity grant', ownerId, column: 'allowed_modes_json' });
		return String(grant.membership_id) === String(row.membership_id)
			&& (!executionProviderIds.length || executionProviderIds.includes(String(provider.id)))
			&& allowedModes.includes(mode);
	}).map((grant) => {
		const granted = new Set(providerCapabilityCompatibility(strings(grant.capabilities_json, { owner: 'capacity grant', ownerId: String(grant.id), column: 'capabilities_json' })));
		const advertised = providerCapabilityCompatibility(provider.capabilities);
		return ({
		capacityProviderId: String(row.capacity_provider_id), membershipId: String(row.membership_id),
		providerSessionId: String(row.id), grantId: String(grant.id), executionProviderId: String(provider.id ?? ''),
		status: capacitySupplyCandidateStatus(provider.status),
		capabilities: advertised.filter((capability) => granted.has(capability)),
		reliability: Number.isFinite(Number(provider.reliability)) ? Math.max(0, Math.min(1, Number(provider.reliability))) : 1,
		pressure: ['idle','normal','busy','throttled','exhausted'].includes(String(provider.pressure)) ? provider.pressure as CapacitySupplyCandidate['pressure'] : 'normal',
		availableConcurrency: Number.isInteger(Number(provider.availableConcurrency)) ? Math.max(0, Number(provider.availableConcurrency)) : 1,
		preferred: provider.preferred === true,
		estimatedCost: Number.isFinite(Number(provider.estimatedCost)) ? Number(provider.estimatedCost) : null,
	});
	})).filter((provider) => provider.executionProviderId);
}

export async function selectWorkdayDemandSupply(database: CapacityGovernanceDatabase, demand: Row, now: string) {
	const metadata = decodeDurableJsonObject(demand.metadata_json, { owner: 'capacity workday demand', ownerId: String(demand.id), column: 'metadata_json' });
	const environment = String(metadata.environment ?? 'local');
	const [team, sessions, grants, agentClass] = await Promise.all([
		database.first('SELECT metadata_json FROM teams WHERE id = ? LIMIT 1', [demand.team_id]),
		database.all(`SELECT session.* FROM capacity_provider_availability_sessions session
			JOIN capacity_provider_team_memberships membership ON membership.id = session.membership_id
			JOIN capacity_providers provider ON provider.id = session.capacity_provider_id
			WHERE session.team_id = ? AND session.status = 'open' AND session.expires_at > ?
			  AND (session.available_from IS NULL OR session.available_from <= ?)
			  AND (session.available_until IS NULL OR session.available_until > ?)
			  AND membership.status = 'approved' AND provider.status = 'active'`,
			[demand.team_id, now, now, now]),
		database.all(`SELECT * FROM capacity_grants WHERE team_id = ? AND project_id = ? AND environment = ?
			AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)`, [demand.team_id, demand.project_id, environment, now]),
		database.first('SELECT required_capabilities_json FROM project_agent_classes WHERE id = ? AND project_id = ? LIMIT 1', [demand.project_agent_class_id, demand.project_id]),
	]);
	const policy = teamSupplyPolicy(team);
	const classCapabilities = strings(agentClass?.required_capabilities_json, { owner: 'project agent class', ownerId: String(demand.project_agent_class_id), column: 'required_capabilities_json' });
	const requiredCapabilities = [...new Set([...(Array.isArray(metadata.requiredCapabilities) ? metadata.requiredCapabilities.map(String).filter(Boolean) : []), ...classCapabilities])];
	const primaryProviderId = String(demand.primary_provider_id ?? '');
	const failoverCount = Math.max(0, Number(metadata.failoverCount ?? 0));
	const failoverAllowed = failoverCount < policy.maxFailovers && (demand.mode === 'acting' ? policy.allowActingFailover : policy.allowPlanningFailover);
	const attemptedSupply = new Set((Array.isArray(metadata.failoverHistory) ? metadata.failoverHistory : []).map((entry) => {
		const value = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Row : {};
		return `${String(value.capacityProviderId ?? '')}:${String(value.executionProviderId ?? '')}`;
	}));
	const portfolio = sessions.flatMap((session) => providers(session, grants, String(demand.mode)))
		.filter((candidate) => !failoverCount || !attemptedSupply.has(`${candidate.capacityProviderId}:${candidate.executionProviderId}`));
	const candidates = failoverAllowed ? portfolio : portfolio.filter((candidate) => candidate.capacityProviderId === primaryProviderId);
	const selection = selectCapacitySupply({ candidates, requiredCapabilities, policy });
	return { ...selection, policy };
}
