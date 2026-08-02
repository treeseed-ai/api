import { MarketControlPlaneStore } from "../../../persistence/store.ts";
export async function membershipOwnerCountMethod(this: MarketControlPlaneStore, teamId) {
    await this.ensureInitialized();
    const row = await this.first(`SELECT COUNT(*) AS count
			 FROM team_memberships
			 INNER JOIN team_role_bindings ON team_role_bindings.team_membership_id = team_memberships.id
			 INNER JOIN roles ON roles.id = team_role_bindings.role_id
			 WHERE team_memberships.team_id = ? AND team_memberships.status = 'active' AND roles.key = 'team_owner'`, [teamId]);
    return Number(row?.count ?? 0);
}
