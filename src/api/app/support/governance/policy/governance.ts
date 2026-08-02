import { ensurePrincipal,isLocalAcceptanceServicePrincipal,isTeamApiPrincipal,jsonError,principalHasPermission,principalIsSeedAdmin } from '../../index.ts';
export async function requireTeamAccess(c, store, teamId, permission = null) {
    const auth = await ensurePrincipal(c);
    if (auth.response) {
        return auth;
    }
    const { principal } = auth;
    if (isLocalAcceptanceServicePrincipal(c, principal)) {
        return { principal };
    }
    if (principalIsSeedAdmin(principal)) {
        return { principal };
    }
    if (!(await store.principalCanAccessTeam(principal, teamId))) {
        return {
            response: jsonError(c, 403, 'Permission denied.', { teamId }),
        };
    }
    if (permission && isTeamApiPrincipal(principal) && !principalHasPermission(principal, permission)) {
        return {
            response: jsonError(c, 403, 'Permission denied.', { permission }),
        };
    }
    if (permission === 'teams:manage:team' && !isTeamApiPrincipal(principal) && !(await store.principalCanManageTeam(principal, teamId))) {
        return {
            response: jsonError(c, 403, 'Permission denied.', { permission }),
        };
    }
    if (permission === 'services:manage:team' && !isTeamApiPrincipal(principal) && !(await store.principalCanManageServices(principal, teamId))) {
        return {
            response: jsonError(c, 403, 'Permission denied.', { permission }),
        };
    }
    if (permission === 'vault:manage:team' && !isTeamApiPrincipal(principal) && !(await store.principalCanManageServiceVault(principal, teamId))) {
        return {
            response: jsonError(c, 403, 'Permission denied.', { permission }),
        };
    }
    if (permission?.startsWith?.('knowledge:') && !isTeamApiPrincipal(principal)) {
        const access = await store.getTeamAccessSummary(teamId, principal);
        if (!access.permissions.includes(permission)) {
            return {
                response: jsonError(c, 403, 'Permission denied.', { permission }),
            };
        }
    }
    return { principal };
}
export async function requireSellerTeamAccess(c, store, teamId, permission = 'projects:read:team') {
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    if (principalIsSeedAdmin(auth.principal))
        return auth;
    const access = await requireTeamAccess(c, store, teamId, permission);
    return access;
}
