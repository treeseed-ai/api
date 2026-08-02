import type { MarketControlPlaneStore } from '../../../persistence/store.ts';
import { principalIsAdmin,SERVICE_MANAGEMENT_ROLES } from '../../../persistence/store.ts';

export async function principalCanManageServicesMethod(
	this: MarketControlPlaneStore,
	principal: unknown,
	teamId: string,
) {
	if (!principal) return false;
	if (principalIsAdmin(principal)) return true;
	const context = await this.resolvePrincipalTeamContext(teamId, principal);
	return Boolean(context?.roles?.some((role) => SERVICE_MANAGEMENT_ROLES.has(String(role))));
}

export async function principalCanManageServiceVaultMethod(
	this: MarketControlPlaneStore,
	principal: unknown,
	teamId: string,
) {
	if (!principal) return false;
	if (principalIsAdmin(principal)) return true;
	const context = await this.resolvePrincipalTeamContext(teamId, principal);
	return Boolean(context?.roles?.includes('team_owner'));
}
