import { MarketControlPlaneStore,serializeGovernanceProposal } from "../../../../../persistence/store.ts";
export async function listGovernanceProposalsMethod(this: MarketControlPlaneStore, filters: any = {}) {
    await this.ensureInitialized();
    const limit = Math.max(1, Math.min(200, Number(filters.limit) || 100));
    const clauses = [];
    const params = [];
    for (const [key, column] of [['teamId', 'team_id'], ['projectId', 'project_id'], ['scope', 'scope'], ['status', 'status']]) {
        if (filters[key]) {
            clauses.push(`${column} = ?`);
            params.push(filters[key]);
        }
    }
    params.push(limit);
    const rows = await this.all(`SELECT * FROM governance_proposals ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
			 ORDER BY updated_at DESC LIMIT ?`, params);
    return rows.map(serializeGovernanceProposal);
}
