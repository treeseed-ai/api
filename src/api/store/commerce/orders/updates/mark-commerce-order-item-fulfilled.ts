import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function markCommerceOrderItemFulfilledMethod(this: MarketControlPlaneStore, orderItemId, input: any = {}) {
    return this.updateCommerceOrderItemStatus(orderItemId, {
        status: 'fulfilled',
        metadata: input.metadata,
    });
}
