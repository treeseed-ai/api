import { ControlPlaneStore,serializeGovernancePolicy } from "../../../../../persistence/store.ts";
export async function getTeamGovernancePolicyMethod(this: ControlPlaneStore, teamId, scope = 'team') {
    await this.ensureInitialized();
    const row = await this.first(`SELECT * FROM team_governance_policies
			 WHERE team_id = ? AND scope = ? AND active = 1
			 ORDER BY updated_at DESC LIMIT 1`, [teamId, scope]);
    if (row)
        return serializeGovernancePolicy(row);
    return this.ensureDefaultTeamGovernancePolicy(teamId, scope);
}
