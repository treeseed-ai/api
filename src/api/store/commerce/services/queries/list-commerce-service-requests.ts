import { MarketControlPlaneStore,serializeCommerceServiceRequest } from "../../../../persistence/store.ts";
export async function listCommerceServiceRequestsMethod(this: MarketControlPlaneStore, principal = null, filters: any = {}) {
    await this.ensureInitialized();
    const clauses = [];
    const params = [];
    for (const [key, column] of [
        ['buyerTeamId', 'buyer_team_id'],
        ['buyerUserId', 'buyer_user_id'],
        ['vendorId', 'vendor_id'],
        ['sellerTeamId', 'seller_team_id'],
        ['status', 'status'],
        ['offerId', 'offer_id'],
        ['relatedProjectId', 'related_project_id'],
        ['relatedWorkdayId', 'related_workday_id'],
    ]) {
        if (filters[key]) {
            clauses.push(`${column} = ?`);
            params.push(filters[key]);
        }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.all(`SELECT * FROM commerce_service_requests ${where} ORDER BY updated_at DESC, created_at DESC`, params);
    return rows.map(serializeCommerceServiceRequest);
}
