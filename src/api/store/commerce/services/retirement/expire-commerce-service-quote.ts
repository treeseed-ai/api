import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function expireCommerceServiceQuoteMethod(this: MarketControlPlaneStore, quoteId, input: any = {}) {
    const quote = await this.getCommerceServiceQuote(quoteId);
    if (!quote)
        return null;
    const updated = await this.updateCommerceServiceQuoteState(quoteId, 'expired', {
        ...input,
        eventType: 'quote_expired',
        action: 'commerce_service.quote_expired',
    });
    await this.updateCommerceServiceRequest(quote.requestId, {
        status: 'expired',
        recordEvent: false,
    });
    return updated;
}
