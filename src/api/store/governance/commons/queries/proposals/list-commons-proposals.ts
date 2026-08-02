import { MarketControlPlaneStore,serializeCommonsProposal } from "../../../../../persistence/store.ts";
export async function listCommonsProposalsMethod(this: MarketControlPlaneStore, filters: any = {}) {
    await this.ensureInitialized();
    const limit = Math.max(1, Math.min(200, Number(filters.limit) || 100));
    const clauses = [];
    const params = [];
    if (filters.status) {
        clauses.push('status = ?');
        params.push(filters.status);
    }
    if (filters.scope) {
        clauses.push('scope = ?');
        params.push(filters.scope);
    }
    params.push(limit);
    const rows = await this.all(`SELECT * FROM commons_proposals ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`, params);
    return rows.map(serializeCommonsProposal);
}
