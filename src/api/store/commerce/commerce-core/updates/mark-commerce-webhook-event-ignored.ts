import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function markCommerceWebhookEventIgnoredMethod(this: MarketControlPlaneStore, eventId, input: any = {}) {
    return this.updateCommerceWebhookEventStatus(eventId, { ...input, status: 'ignored' });
}
