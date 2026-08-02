import { MarketControlPlaneStore,serializeCommercePrice } from "../../../../../persistence/store.ts";
export async function getCommercePriceMethod(this: MarketControlPlaneStore, priceId) {
    await this.ensureInitialized();
    return serializeCommercePrice(await this.first(`SELECT * FROM commerce_prices WHERE id = ? LIMIT 1`, [priceId]));
}
