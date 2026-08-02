import { MarketControlPlaneStore,serializeCommerceOffer } from "../../../../../persistence/store.ts";
export async function listCommerceOffersMethod(this: MarketControlPlaneStore, filters: any = {}) {
    await this.ensureInitialized();
    const clauses = [];
    const params = [];
    for (const [key, column] of [
        ['productId', 'product_id'],
        ['vendorId', 'vendor_id'],
        ['sellerTeamId', 'seller_team_id'],
        ['status', 'status'],
        ['mode', 'mode'],
    ]) {
        if (filters[key]) {
            clauses.push(`${column} = ?`);
            params.push(filters[key]);
        }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.all(`SELECT * FROM commerce_offers ${where} ORDER BY updated_at DESC, created_at DESC`, params);
    return rows.map(serializeCommerceOffer);
}
