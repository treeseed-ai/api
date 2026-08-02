import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function attachCommerceServiceOrderMethod(this: MarketControlPlaneStore, contractId, input: any = {}) {
    const contract = await this.updateCommerceServiceContract(contractId, {
        orderId: input.orderId ?? null,
        orderItemId: input.orderItemId ?? null,
        paymentGroupId: input.paymentGroupId ?? null,
        metadata: input.metadata,
    });
    if (contract) {
        await this.updateCommerceServiceRequest(contract.requestId, {
            orderId: input.orderId ?? null,
            recordEvent: false,
        });
        await this.recordCommerceServiceGovernance({
            requestId: contract.requestId,
            contractId,
            eventType: 'checkout_created',
            action: 'commerce_service.checkout_created',
            objectType: 'commerce_service_contract',
            objectId: contractId,
            actorType: input.actorType ?? 'user',
            actorId: input.actorId ?? null,
            nextState: contract.status,
            evidence: { orderId: input.orderId, orderItemId: input.orderItemId, paymentGroupId: input.paymentGroupId },
            relatedOrderId: input.orderId ?? null,
            relatedOfferId: contract.offerId,
            relatedProductId: contract.productId,
            relatedTeamId: contract.sellerTeamId,
        });
    }
    return contract;
}
