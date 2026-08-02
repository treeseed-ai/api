import { MarketControlPlaneStore } from "../../../../../persistence/store.ts";
export async function listCommerceMarketplaceProductsMethod(this: MarketControlPlaneStore, principal, filters: any = {}) {
    await this.ensureInitialized();
    const products = await this.listCommerceProducts(principal, {
        kind: filters.kind,
        status: filters.status ?? 'approved',
    });
    const summaries = await Promise.all(products
        .filter((product) => product.status === 'approved' && product.visibility === 'public')
        .map((product) => this.commerceMarketplaceProductSummary(product, { publicSafe: true })));
    return { products: summaries.filter(Boolean) };
}
