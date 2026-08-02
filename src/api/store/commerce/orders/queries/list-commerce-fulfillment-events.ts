import { MarketControlPlaneStore,serializeCommerceFulfillmentEvent } from "../../../../persistence/store.ts";
export async function listCommerceFulfillmentEventsMethod(this: MarketControlPlaneStore, filters: any = {}) {
    await this.ensureInitialized();
    const clauses = [];
    const params = [];
    for (const [key, column] of [
        ['orderId', 'order_id'],
        ['orderItemId', 'order_item_id'],
        ['entitlementId', 'entitlement_id'],
        ['vendorId', 'vendor_id'],
        ['sellerTeamId', 'seller_team_id'],
        ['productId', 'product_id'],
        ['status', 'status'],
    ]) {
        if (filters[key]) {
            clauses.push(`${column} = ?`);
            params.push(filters[key]);
        }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.all(`SELECT * FROM commerce_fulfillment_events ${where} ORDER BY created_at DESC`, params);
    return rows.map(serializeCommerceFulfillmentEvent);
}
