import { ControlPlaneStore } from "../../../persistence/store.ts";
import type { OperationInvocationContext } from '../../../control-plane/catalog/operation-registry.ts';
export async function principalCanAccessTeamMethod(this: ControlPlaneStore, principal: OperationInvocationContext['principal'] | null, teamId: string) {
    if (!principal)
        return false;
    const teamIds = await this.teamIdsForPrincipal(principal);
    return teamIds.includes(teamId);
}
