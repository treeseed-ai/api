import { ControlPlaneStore,serializeCommonsGovernanceEvent } from "../../../../../persistence/store.ts";
export async function listCommonsGovernanceEventsMethod(this: ControlPlaneStore, filters: any = {}) {
    await this.ensureInitialized();
    const limit = Math.max(1, Math.min(300, Number(filters.limit) || 100));
    const clauses = [];
    const params = [];
    for (const [key, column] of [
        ['proposalId', 'proposal_id'],
        ['questionId', 'question_id'],
        ['participantId', 'participant_id'],
        ['decisionId', 'decision_id'],
        ['eventType', 'event_type'],
    ]) {
        if (filters[key]) {
            clauses.push(`${column} = ?`);
            params.push(filters[key]);
        }
    }
    params.push(limit);
    const rows = await this.all(`SELECT * FROM commons_governance_events ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`, params);
    return rows.map(serializeCommonsGovernanceEvent);
}
