import { ControlPlaneStore,serializeGovernancePolicy } from "../../../../../persistence/store.ts";
export async function getTeamGovernancePolicyMethod(this: ControlPlaneStore, teamId: string, scope = 'team') {
    await this.ensureInitialized();
    const row = await this.first<GovernancePolicyRow>(`SELECT * FROM team_governance_policies
			 WHERE team_id = ? AND scope = ? AND active = 1
			 ORDER BY updated_at DESC LIMIT 1`, [teamId, scope]);
    if (row)
        return serializeGovernancePolicy(row);
    return this.ensureDefaultTeamGovernancePolicy(teamId, scope);
}
import type { GovernancePolicyRow } from "../../../../support/governance/policy/governance.ts";
