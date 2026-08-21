import { governanceVotingProvider } from '@treeseed/sdk';
import { COMMONS_TEAM_SLUG,isoNow,ControlPlaneStore,serializeGovernancePolicy } from "../../../../persistence/store.ts";
export async function ensureDefaultTeamGovernancePolicyMethod(this: ControlPlaneStore, teamId, scope = 'team') {
    await this.ensureInitialized();
    const existing = await this.first(`SELECT * FROM team_governance_policies
			 WHERE team_id = ? AND scope = ? AND active = 1
			 ORDER BY updated_at DESC LIMIT 1`, [teamId, scope]);
    if (existing)
        return serializeGovernancePolicy(existing);
    const timestamp = isoNow();
    const providerId = teamId === COMMONS_TEAM_SLUG || scope === 'commons' ? 'treeseed_bicameral_v1' : 'admin_approval_v1';
    const provider = governanceVotingProvider(providerId);
    const id = `governance-policy:${teamId}:${scope}`;
    await this.run(`INSERT INTO team_governance_policies (
				id, team_id, scope, provider_id, provider_version, config_json, active, created_by, created_at, updated_at, superseded_at
			) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, NULL)`, [id, teamId, scope, provider.id, provider.version, JSON.stringify({}), timestamp, timestamp]);
    return serializeGovernancePolicy(await this.first(`SELECT * FROM team_governance_policies WHERE id = ? LIMIT 1`, [id]));
}
