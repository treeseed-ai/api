import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function linkCommerceServiceContractWorkMethod(this: MarketControlPlaneStore, contractId, input: any = {}) {
    const existing = await this.getCommerceServiceContract(contractId);
    if (!existing)
        return null;
    const contract = await this.updateCommerceServiceContract(contractId, {
        relatedProjectId: input.relatedProjectId ?? existing.relatedProjectId,
        relatedWorkdayId: input.relatedWorkdayId ?? existing.relatedWorkdayId,
        metadata: input.metadata ?? existing.metadata,
    });
    await this.updateCommerceServiceRequest(existing.requestId, {
        relatedProjectId: input.relatedProjectId ?? existing.relatedProjectId,
        relatedWorkdayId: input.relatedWorkdayId ?? existing.relatedWorkdayId,
        recordEvent: false,
    });
    await this.recordCommerceServiceGovernance({
        requestId: existing.requestId,
        quoteId: existing.quoteId,
        contractId,
        eventType: 'work_linked',
        action: 'commerce_service.work_linked',
        objectType: 'commerce_service_contract',
        objectId: contractId,
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        priorState: existing.status,
        nextState: contract?.status ?? existing.status,
        evidence: {
            relatedProjectId: input.relatedProjectId ?? existing.relatedProjectId,
            relatedWorkdayId: input.relatedWorkdayId ?? existing.relatedWorkdayId,
        },
        relatedOfferId: existing.offerId,
        relatedProductId: existing.productId,
        relatedTeamId: existing.sellerTeamId,
    });
    return contract;
}
