import { MarketControlPlaneStore,serializeGovernanceEvent } from "../../../../../persistence/store.ts";
export async function listGovernanceEventsMethod(this: MarketControlPlaneStore, filters: any = {}) {
    await this.ensureInitialized();
    const limit = Math.max(1, Math.min(300, Number(filters.limit) || 100));
    const clauses = [];
    const params = [];
    for (const [key, column] of [['teamId', 'team_id'], ['projectId', 'project_id'], ['proposalId', 'proposal_id'], ['decisionId', 'decision_id'], ['eventType', 'event_type']]) {
        if (filters[key]) {
            clauses.push(`${column} = ?`);
            params.push(filters[key]);
        }
    }
    params.push(limit);
    const rows = await this.all(`SELECT * FROM governance_events ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
			 ORDER BY created_at DESC LIMIT ?`, params);
    return rows.map(serializeGovernanceEvent);
}
