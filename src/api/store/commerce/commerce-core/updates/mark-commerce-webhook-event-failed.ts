import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function markCommerceWebhookEventFailedMethod(this: MarketControlPlaneStore, eventId, input: any = {}) {
    return this.updateCommerceWebhookEventStatus(eventId, { ...input, status: 'failed' });
}
