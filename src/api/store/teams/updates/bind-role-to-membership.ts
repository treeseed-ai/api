import { isoNow,MarketControlPlaneStore } from "../../../persistence/store.ts";
export async function bindRoleToMembershipMethod(this: MarketControlPlaneStore, teamMembershipId, roleKey) {
    await this.ensureInitialized();
    const roleId = await this.roleIdForKey(roleKey);
    if (!roleId)
        return;
    await this.run(`INSERT OR IGNORE INTO team_role_bindings (team_membership_id, role_id, created_at)
			 VALUES (?, ?, ?)`, [teamMembershipId, roleId, isoNow()]);
}
