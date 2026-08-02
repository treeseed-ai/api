import { MarketControlPlaneStore,serializeCommerceGovernancePolicy } from "../../../../persistence/store.ts";
export async function listCommerceGovernancePoliciesMethod(this: MarketControlPlaneStore, filters: any = {}) {
    await this.ensureInitialized();
    const clauses = [];
    const params = [];
    if (filters.productId) {
        clauses.push('product_id = ?');
        params.push(filters.productId);
    }
    if (filters.teamId) {
        clauses.push('team_id = ?');
        params.push(filters.teamId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.all(`SELECT * FROM commerce_governance_policies ${where} ORDER BY updated_at DESC`, params);
    return rows.map(serializeCommerceGovernancePolicy);
}
