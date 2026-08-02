import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function submitCommerceProductMethod(this: MarketControlPlaneStore, productId, input: any = {}) {
    return this.transitionCommerceProduct(productId, 'submitted', input);
}
