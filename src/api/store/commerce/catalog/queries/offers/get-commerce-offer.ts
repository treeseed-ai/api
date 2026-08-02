import { MarketControlPlaneStore,serializeCommerceOffer } from "../../../../../persistence/store.ts";
export async function getCommerceOfferMethod(this: MarketControlPlaneStore, offerId) {
    await this.ensureInitialized();
    return serializeCommerceOffer(await this.first(`SELECT * FROM commerce_offers WHERE id = ? LIMIT 1`, [offerId]));
}
