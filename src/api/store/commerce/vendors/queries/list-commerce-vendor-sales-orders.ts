import { MarketControlPlaneStore,serializeCommerceVendorOrderSummary } from "../../../../persistence/store.ts";
export async function listCommerceVendorSalesOrdersMethod(this: MarketControlPlaneStore, teamId, filters: any = {}) {
    await this.ensureInitialized();
    const clauses = ['seller_team_id = ?'];
    const params = [teamId];
    if (filters.status) {
        clauses.push('status = ?');
        params.push(filters.status);
    }
    const rows = await this.all(`SELECT * FROM commerce_orders WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, created_at DESC`, params);
    const summaries = [];
    for (const row of rows) {
        const itemCount = await this.first(`SELECT COUNT(*) AS count FROM commerce_order_items WHERE order_id = ?`, [row.id]);
        const buyerTeam = row.buyer_team_id ? await this.first(`SELECT display_name FROM teams WHERE id = ? LIMIT 1`, [row.buyer_team_id]) : null;
        summaries.push(serializeCommerceVendorOrderSummary({
            ...row,
            item_count: itemCount?.count ?? 0,
            buyer_team_name: buyerTeam?.display_name ?? null,
        }));
    }
    return summaries;
}
