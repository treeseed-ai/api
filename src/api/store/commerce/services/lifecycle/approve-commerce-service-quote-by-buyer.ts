import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function approveCommerceServiceQuoteByBuyerMethod(this: MarketControlPlaneStore, quoteId, input: any = {}) {
    const quote = await this.getCommerceServiceQuote(quoteId);
    if (!quote)
        return null;
    if (quote.status !== 'submitted') {
        const error: Error & Record<string, any> = new Error('Only submitted service quotes can be buyer-approved.');
        error.status = 409;
        throw error;
    }
    const timestamp = isoNow();
    const updated = await this.updateCommerceServiceQuoteState(quoteId, 'buyer_approved', {
        ...input,
        buyerApprovedAt: timestamp,
        eventType: 'quote_buyer_approved',
        action: 'commerce_service.quote_buyer_approved',
    });
    await this.updateCommerceServiceRequest(quote.requestId, {
        status: 'buyer_approved',
        recordEvent: false,
    });
    return updated;
}
