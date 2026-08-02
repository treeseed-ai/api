import { MarketControlPlaneStore,serializeCommerceSuccessionEvent } from "../../../../persistence/store.ts";
export async function listCommerceSuccessionEventsMethod(this: MarketControlPlaneStore, productId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM commerce_succession_events WHERE product_id = ? ORDER BY created_at DESC`, [productId]);
    return rows.map(serializeCommerceSuccessionEvent);
}
