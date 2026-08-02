import { MarketControlPlaneStore,serializeCommerceEntitlement } from "../../../../../persistence/store.ts";
export async function listCommerceEntitlementsMethod(this: MarketControlPlaneStore, principal = null, filters: any = {}) {
    await this.ensureInitialized();
    const clauses = [];
    const params = [];
    for (const [key, column] of [
        ['buyerTeamId', 'buyer_team_id'],
        ['buyerUserId', 'buyer_user_id'],
        ['productId', 'product_id'],
        ['offerId', 'offer_id'],
        ['sellerTeamId', 'seller_team_id'],
        ['status', 'status'],
        ['orderId', 'order_id'],
    ]) {
        if (filters[key]) {
            clauses.push(`${column} = ?`);
            params.push(filters[key]);
        }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.all(`SELECT * FROM commerce_entitlements ${where} ORDER BY updated_at DESC, created_at DESC`, params);
    return rows.map(serializeCommerceEntitlement);
}
