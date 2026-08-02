import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function submitCommerceOfferMethod(this: MarketControlPlaneStore, offerId, input: any = {}) {
    return this.transitionCommerceOffer(offerId, 'submitted', input);
}
