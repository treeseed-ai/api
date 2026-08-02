import { MarketControlPlaneStore,serializeGovernanceDelegation } from "../../../../../persistence/store.ts";
export async function listGovernanceDelegationsMethod(this: MarketControlPlaneStore, filters: any = {}) {
    await this.ensureInitialized();
    const limit = Math.max(1, Math.min(300, Number(filters.limit) || 100));
    const clauses = [];
    const params = [];
    for (const [key, column] of [['teamId', 'team_id'], ['scope', 'scope'], ['status', 'status'], ['fromUserId', 'from_user_id'], ['toUserId', 'to_user_id']]) {
        if (filters[key]) {
            clauses.push(`${column} = ?`);
            params.push(filters[key]);
        }
    }
    params.push(limit);
    const rows = await this.all(`SELECT * FROM governance_delegations ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
			 ORDER BY created_at DESC LIMIT ?`, params);
    return rows.map(serializeGovernanceDelegation);
}
