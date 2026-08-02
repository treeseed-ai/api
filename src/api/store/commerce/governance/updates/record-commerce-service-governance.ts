import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function recordCommerceServiceGovernanceMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.recordCommerceServiceEvent(input);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: input.action ?? `commerce_service.${input.eventType ?? 'manual_update'}`,
        objectType: input.objectType ?? 'commerce_service_request',
        objectId: input.objectId ?? input.requestId,
        priorState: input.priorState ?? null,
        nextState: input.nextState ?? null,
        reason: input.message ?? input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedOrderId: input.relatedOrderId ?? null,
        relatedOfferId: input.relatedOfferId ?? null,
        relatedProductId: input.relatedProductId ?? null,
        relatedTeamId: input.relatedTeamId ?? null,
    });
}
