import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function cancelCommerceServiceContractMethod(this: MarketControlPlaneStore, contractId, input: any = {}) {
    const existing = await this.getCommerceServiceContract(contractId);
    if (!existing)
        return null;
    const contract = await this.updateCommerceServiceContract(contractId, {
        status: 'canceled',
        metadata: input.metadata ?? existing.metadata,
    });
    await this.updateCommerceServiceRequest(existing.requestId, {
        status: 'canceled',
        recordEvent: false,
    });
    await this.recordCommerceServiceGovernance({
        requestId: existing.requestId,
        quoteId: existing.quoteId,
        contractId,
        eventType: 'canceled',
        action: 'commerce_service.canceled',
        objectType: 'commerce_service_contract',
        objectId: contractId,
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        priorState: existing.status,
        nextState: 'canceled',
        message: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedOfferId: existing.offerId,
        relatedProductId: existing.productId,
        relatedTeamId: existing.sellerTeamId,
    });
    return contract;
}
