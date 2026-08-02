import { ensurePrincipal,jsonError,principalIsSeedAdmin,requireTeamAccess } from './index.ts';
export async function requireServiceBuyerAccess(c, store, request) {
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    if (principalIsSeedAdmin(auth.principal))
        return auth;
    if (request?.buyerTeamId) {
        const access = await requireTeamAccess(c, store, request.buyerTeamId, 'projects:read:team');
        if (!access.response)
            return access;
    }
    if (request?.buyerUserId && request.buyerUserId === auth.principal.id)
        return auth;
    return { response: jsonError(c, 403, 'Permission denied.', { requestId: request?.id ?? null }) };
}
export async function requireServiceSellerAccess(c, store, request, permission = 'teams:manage:team') {
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    if (principalIsSeedAdmin(auth.principal))
        return auth;
    if (!request?.sellerTeamId)
        return { response: jsonError(c, 404, 'Commerce service request does not have a seller team.') };
    return requireTeamAccess(c, store, request.sellerTeamId, permission);
}
export async function requireCatalogItemAccess(c, store, itemId, permission = null) {
    const auth = await ensurePrincipal(c);
    if (auth.response) {
        return auth;
    }
    const item = await store.getCatalogItem(itemId);
    if (!item) {
        return {
            response: jsonError(c, 404, `Unknown catalog item "${itemId}".`),
        };
    }
    const access = await requireTeamAccess(c, store, item.teamId, permission);
    if (access.response) {
        return access;
    }
    return {
        principal: access.principal,
        item,
    };
}
