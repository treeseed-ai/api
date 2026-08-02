import { MarketControlPlaneStore,serializeCommerceServiceQuote } from "../../../../persistence/store.ts";
export async function getCommerceServiceQuoteMethod(this: MarketControlPlaneStore, quoteId) {
    await this.ensureInitialized();
    return serializeCommerceServiceQuote(await this.first(`SELECT * FROM commerce_service_quotes WHERE id = ? LIMIT 1`, [quoteId]));
}
