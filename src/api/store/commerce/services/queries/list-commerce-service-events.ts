import { MarketControlPlaneStore,serializeCommerceServiceEvent } from "../../../../persistence/store.ts";
export async function listCommerceServiceEventsMethod(this: MarketControlPlaneStore, filters: any = {}) {
    await this.ensureInitialized();
    const clauses = [];
    const params = [];
    for (const [key, column] of [
        ['requestId', 'request_id'],
        ['quoteId', 'quote_id'],
        ['contractId', 'contract_id'],
        ['eventType', 'event_type'],
    ]) {
        if (filters[key]) {
            clauses.push(`${column} = ?`);
            params.push(filters[key]);
        }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.all(`SELECT * FROM commerce_service_events ${where} ORDER BY created_at ASC`, params);
    return rows.map(serializeCommerceServiceEvent);
}
