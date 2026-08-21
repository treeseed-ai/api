import { ControlPlaneStore,TEAM_MANAGEMENT_ROLES } from "../../../persistence/store.ts";
export async function principalCanManageTeamMethod(this: ControlPlaneStore, principal, teamId) {
    if (!principal)
        return false;
    const context = await this.resolvePrincipalTeamContext(teamId, principal);
    return Boolean(context?.roles?.some((role) => TEAM_MANAGEMENT_ROLES.has(String(role))));
}
