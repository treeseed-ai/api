import { ControlPlaneStore } from "../../../persistence/store.ts";
export async function principalCanAccessTeamMethod(this: ControlPlaneStore, principal, teamId) {
    if (!principal)
        return false;
    const teamIds = await this.teamIdsForPrincipal(principal);
    return teamIds.includes(teamId);
}
