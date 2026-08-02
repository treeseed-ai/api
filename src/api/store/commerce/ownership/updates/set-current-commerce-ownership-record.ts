import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function setCurrentCommerceOwnershipRecordMethod(this: MarketControlPlaneStore, productId, ownershipRecordId) {
    await this.ensureInitialized();
    const ownership = await this.first(`SELECT * FROM commerce_ownership_records WHERE id = ? AND product_id = ? LIMIT 1`, [ownershipRecordId, productId]);
    if (!ownership)
        return null;
    await this.run(`UPDATE commerce_products SET ownership_record_id = ?, ownership_model = ?, updated_at = ? WHERE id = ?`, [ownershipRecordId, ownership.model, isoNow(), productId]);
    return this.getCommerceProduct(productId);
}
