import { MarketControlPlaneStore,serializeCommerceOwnershipRecord } from "../../../../persistence/store.ts";
export async function listCommerceOwnershipRecordsMethod(this: MarketControlPlaneStore, productId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM commerce_ownership_records WHERE product_id = ? ORDER BY effective_at DESC, created_at DESC`, [productId]);
    return rows.map(serializeCommerceOwnershipRecord);
}
