import { ControlPlaneStore,normalizeTeamRoleKey } from "../../../persistence/store.ts";
export async function replaceMembershipRoleMethod(this: ControlPlaneStore, membershipId: string, roleKey: unknown) {
    await this.ensureInitialized();
    const role = normalizeTeamRoleKey(roleKey);
    await this.run(`DELETE FROM team_role_bindings WHERE team_membership_id = ?`, [membershipId]);
    await this.bindRoleToMembership(membershipId, role);
}
