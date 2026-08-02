import { MarketControlPlaneStore } from "../../../persistence/store.ts";
export async function principalCanAccessTeamMethod(this: MarketControlPlaneStore, principal, teamId) {
    if (!principal)
        return false;
    const teamIds = await this.teamIdsForPrincipal(principal);
    return teamIds.includes(teamId);
}
