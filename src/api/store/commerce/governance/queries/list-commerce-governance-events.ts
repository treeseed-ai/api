import { MarketControlPlaneStore,serializeCommerceGovernanceEvent } from "../../../../persistence/store.ts";
export async function listCommerceGovernanceEventsMethod(this: MarketControlPlaneStore, filters: any = {}) {
    await this.ensureInitialized();
    const clauses = [];
    const params = [];
    for (const [key, column] of [
        ['objectType', 'object_type'],
        ['objectId', 'object_id'],
        ['productId', 'related_product_id'],
        ['offerId', 'related_offer_id'],
        ['teamId', 'related_team_id'],
    ]) {
        if (filters[key]) {
            clauses.push(`${column} = ?`);
            params.push(filters[key]);
        }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.all(`SELECT * FROM commerce_governance_events ${where} ORDER BY created_at DESC`, params);
    return rows.map(serializeCommerceGovernanceEvent);
}
