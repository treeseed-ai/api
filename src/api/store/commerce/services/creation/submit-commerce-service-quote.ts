import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function submitCommerceServiceQuoteMethod(this: MarketControlPlaneStore, quoteId, input: any = {}) {
    const quote = await this.getCommerceServiceQuote(quoteId);
    if (!quote)
        return null;
    if (quote.status !== 'draft') {
        const error: Error & Record<string, any> = new Error('Only draft service quotes can be submitted.');
        error.status = 409;
        throw error;
    }
    const updated = await this.updateCommerceServiceQuoteState(quoteId, 'submitted', {
        ...input,
        eventType: 'quote_submitted',
        action: 'commerce_service.quote_submitted',
    });
    await this.updateCommerceServiceRequest(quote.requestId, {
        status: 'quoted',
        activeQuoteId: quoteId,
        recordEvent: false,
    });
    return updated;
}
