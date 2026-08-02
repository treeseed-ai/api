import { MarketControlPlaneStore,principalIsAdmin } from "../../../../../persistence/store.ts";
export async function getCommerceMarketplaceProductMethod(this: MarketControlPlaneStore, productId, principal = null) {
    await this.ensureInitialized();
    const product = await this.getCommerceProduct(productId);
    if (!product)
        return null;
    const teamIds = await this.teamIdsForPrincipal(principal);
    const canSeePrivate = principalIsAdmin(principal) || teamIds.includes(product.sellerTeamId);
    if (!canSeePrivate && (product.status !== 'approved' || product.visibility !== 'public'))
        return null;
    return this.commerceMarketplaceProductSummary(product, { publicSafe: !canSeePrivate });
}
