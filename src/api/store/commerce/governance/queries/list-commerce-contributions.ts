import { MarketControlPlaneStore,serializeCommerceContribution } from "../../../../persistence/store.ts";
export async function listCommerceContributionsMethod(this: MarketControlPlaneStore, productId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM commerce_contributions WHERE product_id = ? ORDER BY effective_at DESC, created_at DESC`, [productId]);
    return rows.map(serializeCommerceContribution);
}
