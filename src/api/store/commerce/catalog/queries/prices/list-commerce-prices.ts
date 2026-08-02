import { MarketControlPlaneStore,serializeCommercePrice } from "../../../../../persistence/store.ts";
export async function listCommercePricesMethod(this: MarketControlPlaneStore, offerId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM commerce_prices WHERE offer_id = ? ORDER BY price_version DESC`, [offerId]);
    return rows.map(serializeCommercePrice);
}
