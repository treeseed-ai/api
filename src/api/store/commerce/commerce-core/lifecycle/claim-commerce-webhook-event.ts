import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function claimCommerceWebhookEventMethod(this: MarketControlPlaneStore, eventId) {
    return this.updateCommerceWebhookEventStatus(eventId, { status: 'processing' });
}
