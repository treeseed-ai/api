import { governanceVotingProvider } from '@treeseed/sdk';
import { isoNow,MarketControlPlaneStore,objectValue,optionalStringValue,serializeGovernancePolicy } from "../../../../persistence/store.ts";
export async function setTeamGovernancePolicyMethod(this: MarketControlPlaneStore, teamId, input: any = {}) {
    await this.ensureInitialized();
    const scope = optionalStringValue(input.scope, 'team');
    const provider = governanceVotingProvider(optionalStringValue(input.providerId, 'admin_approval_v1'));
    const timestamp = isoNow();
    await this.run(`UPDATE team_governance_policies SET active = 0, superseded_at = ?, updated_at = ?
			 WHERE team_id = ? AND scope = ? AND active = 1`, [timestamp, timestamp, teamId, scope]);
    const id = input.id ?? `governance-policy:${teamId}:${scope}:${Date.parse(timestamp)}`;
    await this.run(`INSERT INTO team_governance_policies (
				id, team_id, scope, provider_id, provider_version, config_json, active, created_by, created_at, updated_at, superseded_at
			) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)`, [id, teamId, scope, provider.id, provider.version, JSON.stringify(objectValue(input.config, {})), input.createdBy ?? null, timestamp, timestamp]);
    return serializeGovernancePolicy(await this.first(`SELECT * FROM team_governance_policies WHERE id = ? LIMIT 1`, [id]));
}
