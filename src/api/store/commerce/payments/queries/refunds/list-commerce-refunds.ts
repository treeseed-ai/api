import { MarketControlPlaneStore,serializeCommerceRefund } from "../../../../../persistence/store.ts";
export async function listCommerceRefundsMethod(this: MarketControlPlaneStore, principal = null, filters: any = {}) {
    await this.ensureInitialized();
    const clauses = [];
    const params = [];
    for (const [key, column] of [
        ['orderId', 'order_id'],
        ['vendorId', 'vendor_id'],
        ['sellerTeamId', 'seller_team_id'],
        ['buyerTeamId', 'buyer_team_id'],
        ['buyerUserId', 'buyer_user_id'],
        ['status', 'status'],
    ]) {
        if (filters[key]) {
            clauses.push(`${column} = ?`);
            params.push(filters[key]);
        }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.all(`SELECT * FROM commerce_refunds ${where} ORDER BY created_at DESC`, params);
    return rows.map(serializeCommerceRefund);
}
