import { MarketControlPlaneStore,serializeCommerceOrder } from "../../../../persistence/store.ts";
export async function listCommerceOrdersMethod(this: MarketControlPlaneStore, principal = null, filters: any = {}) {
    await this.ensureInitialized();
    const clauses = [];
    const params = [];
    for (const [key, column] of [
        ['buyerTeamId', 'buyer_team_id'],
        ['vendorId', 'vendor_id'],
        ['status', 'status'],
        ['checkoutId', 'checkout_id'],
    ]) {
        if (filters[key]) {
            clauses.push(`${column} = ?`);
            params.push(filters[key]);
        }
    }
    if (filters.buyerUserId) {
        clauses.push(`buyer_user_id = ?`);
        params.push(filters.buyerUserId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.all(`SELECT * FROM commerce_orders ${where} ORDER BY updated_at DESC, created_at DESC`, params);
    return rows.map(serializeCommerceOrder);
}
