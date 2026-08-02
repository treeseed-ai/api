import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function fulfillCommerceServiceContractMethod(this: MarketControlPlaneStore, contractId, input: any = {}) {
    const existing = await this.getCommerceServiceContract(contractId);
    if (!existing)
        return null;
    const contract = await this.updateCommerceServiceContract(contractId, {
        status: 'fulfilled',
        fulfillmentSummary: input.summary ?? existing.fulfillmentSummary,
        metadata: input.metadata ?? existing.metadata,
    });
    await this.updateCommerceServiceRequest(existing.requestId, {
        status: 'fulfilled',
        recordEvent: false,
    });
    await this.recordCommerceServiceGovernance({
        requestId: existing.requestId,
        quoteId: existing.quoteId,
        contractId,
        eventType: 'fulfilled',
        action: 'commerce_service.fulfilled',
        objectType: 'commerce_service_contract',
        objectId: contractId,
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        priorState: existing.status,
        nextState: 'fulfilled',
        message: input.summary ?? null,
        evidence: input.evidence ?? {},
        relatedOrderId: existing.orderId,
        relatedOfferId: existing.offerId,
        relatedProductId: existing.productId,
        relatedTeamId: existing.sellerTeamId,
    });
    return contract;
}
