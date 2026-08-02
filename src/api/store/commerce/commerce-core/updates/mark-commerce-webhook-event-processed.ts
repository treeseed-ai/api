import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function markCommerceWebhookEventProcessedMethod(this: MarketControlPlaneStore, eventId, input: any = {}) {
    return this.updateCommerceWebhookEventStatus(eventId, { ...input, status: 'processed' });
}
