import type { ControlPlaneStore } from '../../../persistence/store.ts';
import { principalIsAdmin,SERVICE_MANAGEMENT_ROLES } from '../../../persistence/store.ts';
import type { OperationInvocationContext } from '../../../control-plane/catalog/operation-registry.ts';

export async function principalCanManageServicesMethod(
	this: ControlPlaneStore,
	principal: OperationInvocationContext['principal'] | null,
	teamId: string,
) {
	if (!principal) return false;
	if (principalIsAdmin(principal)) return true;
	const context = await this.resolvePrincipalTeamContext(teamId, principal);
	return Boolean(context?.roles?.some((role) => SERVICE_MANAGEMENT_ROLES.has(String(role))));
}
