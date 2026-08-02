import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function markCommerceOrderItemRefundStateMethod(this: MarketControlPlaneStore, orderItemId, input: any = {}) {
    return this.updateCommerceOrderItemStatus(orderItemId, {
        status: input.status,
        refundedAmount: input.refundedAmount,
        refundStatus: input.refundStatus,
        metadata: input.metadata,
    });
}
