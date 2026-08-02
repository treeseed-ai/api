import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function archiveCommerceOfferMethod(this: MarketControlPlaneStore, offerId, input: any = {}) {
    return this.transitionCommerceOffer(offerId, 'archived', input);
}
