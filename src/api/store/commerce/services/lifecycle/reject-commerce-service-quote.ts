import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function rejectCommerceServiceQuoteMethod(this: MarketControlPlaneStore, quoteId, input: any = {}) {
    const quote = await this.getCommerceServiceQuote(quoteId);
    if (!quote)
        return null;
    const updated = await this.updateCommerceServiceQuoteState(quoteId, 'rejected', {
        ...input,
        rejectedAt: isoNow(),
        eventType: 'quote_rejected',
        action: 'commerce_service.quote_rejected',
    });
    await this.updateCommerceServiceRequest(quote.requestId, {
        status: 'scoping',
        recordEvent: false,
    });
    return updated;
}
