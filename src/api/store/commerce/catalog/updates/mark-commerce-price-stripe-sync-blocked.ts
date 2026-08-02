import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function markCommercePriceStripeSyncBlockedMethod(this: MarketControlPlaneStore, priceId, input: any = {}) {
    return this.updateCommercePriceStripeSync(priceId, {
        ...input,
        stripeSyncStatus: 'blocked',
        stripeSyncError: input.reason ?? input.stripeSyncError ?? 'Stripe price sync is blocked.',
        action: 'commerce_price.stripe_price.sync_blocked',
    });
}
