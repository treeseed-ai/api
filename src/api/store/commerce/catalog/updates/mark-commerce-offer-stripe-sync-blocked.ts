import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function markCommerceOfferStripeSyncBlockedMethod(this: MarketControlPlaneStore, offerId, input: any = {}) {
    return this.updateCommerceOfferStripeProductSync(offerId, {
        ...input,
        stripeProductStatus: 'blocked',
        stripeProductSyncError: input.reason ?? input.stripeProductSyncError ?? 'Stripe product sync is blocked.',
        action: 'commerce_offer.stripe_product.sync_blocked',
    });
}
