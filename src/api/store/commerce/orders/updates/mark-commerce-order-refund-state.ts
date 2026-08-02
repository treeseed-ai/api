import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function markCommerceOrderRefundStateMethod(this: MarketControlPlaneStore, orderId, input: any = {}) {
    return this.updateCommerceOrderStatus(orderId, {
        status: input.status,
        refundedAmount: input.refundedAmount,
        refundStatus: input.refundStatus,
        metadata: input.metadata,
    });
}
