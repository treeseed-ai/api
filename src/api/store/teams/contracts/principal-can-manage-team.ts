import { ControlPlaneStore,TEAM_MANAGEMENT_ROLES } from "../../../persistence/store.ts";
import type { OperationInvocationContext } from '../../../control-plane/catalog/operation-registry.ts';
export async function principalCanManageTeamMethod(this: ControlPlaneStore, principal: OperationInvocationContext['principal'] | null, teamId: string) {
    if (!principal)
        return false;
    const context = await this.resolvePrincipalTeamContext(teamId, principal);
    return Boolean(context?.roles?.some((role) => TEAM_MANAGEMENT_ROLES.has(String(role))));
}
