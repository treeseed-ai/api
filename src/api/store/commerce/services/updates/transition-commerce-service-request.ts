import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function transitionCommerceServiceRequestMethod(this: MarketControlPlaneStore, requestId, nextState, input: any = {}) {
    return this.updateCommerceServiceRequest(requestId, {
        ...input,
        status: nextState,
        eventType: input.eventType ?? (nextState === 'canceled' ? 'canceled' : 'manual_update'),
        action: input.action ?? `commerce_service.${nextState}`,
    });
}
