import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function activateCommerceServiceContractMethod(this: MarketControlPlaneStore, contractId, input: any = {}) {
    const existing = await this.getCommerceServiceContract(contractId);
    if (!existing)
        return null;
    const contract = await this.updateCommerceServiceContract(contractId, {
        status: 'active',
        entitlementId: input.entitlementId ?? existing.entitlementId,
        metadata: input.metadata ?? existing.metadata,
    });
    await this.updateCommerceServiceRequest(existing.requestId, {
        status: 'active',
        entitlementId: input.entitlementId ?? existing.entitlementId,
        orderId: input.orderId ?? existing.orderId,
        recordEvent: false,
    });
    await this.recordCommerceServiceGovernance({
        requestId: existing.requestId,
        quoteId: existing.quoteId,
        contractId,
        eventType: 'contract_activated',
        action: 'commerce_service.contract_activated',
        objectType: 'commerce_service_contract',
        objectId: contractId,
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        priorState: existing.status,
        nextState: 'active',
        evidence: { entitlementId: input.entitlementId ?? existing.entitlementId },
        relatedOrderId: input.orderId ?? existing.orderId,
        relatedOfferId: existing.offerId,
        relatedProductId: existing.productId,
        relatedTeamId: existing.sellerTeamId,
    });
    return contract;
}
