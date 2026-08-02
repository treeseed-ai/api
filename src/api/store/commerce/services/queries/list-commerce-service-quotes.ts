import { MarketControlPlaneStore,serializeCommerceServiceQuote } from "../../../../persistence/store.ts";
export async function listCommerceServiceQuotesMethod(this: MarketControlPlaneStore, requestId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM commerce_service_quotes WHERE request_id = ? ORDER BY quote_version DESC`, [requestId]);
    return rows.map(serializeCommerceServiceQuote);
}
