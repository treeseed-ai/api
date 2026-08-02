import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function archiveCommerceProductMethod(this: MarketControlPlaneStore, productId, input: any = {}) {
    return this.transitionCommerceProduct(productId, 'archived', input);
}
