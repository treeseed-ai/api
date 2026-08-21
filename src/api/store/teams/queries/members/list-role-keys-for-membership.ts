import { ControlPlaneStore,uniqueStrings } from "../../../../persistence/store.ts";
export async function listRoleKeysForMembershipMethod(this: ControlPlaneStore, teamMembershipId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT roles.key
			 FROM team_role_bindings
			 INNER JOIN roles ON roles.id = team_role_bindings.role_id
			 WHERE team_role_bindings.team_membership_id = ?
			 ORDER BY roles.key ASC`, [teamMembershipId]);
    return uniqueStrings(rows.map((row) => row.key));
}
