import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function approveCommerceServiceQuoteByVendorMethod(this: MarketControlPlaneStore, quoteId, input: any = {}) {
    const quote = await this.getCommerceServiceQuote(quoteId);
    if (!quote)
        return null;
    if (quote.status !== 'buyer_approved') {
        const error: Error & Record<string, any> = new Error('Only buyer-approved service quotes can be vendor-approved.');
        error.status = 409;
        throw error;
    }
    const timestamp = isoNow();
    const updated = await this.updateCommerceServiceQuoteState(quoteId, 'accepted', {
        ...input,
        vendorApprovedAt: timestamp,
        acceptedAt: timestamp,
        eventType: 'quote_vendor_approved',
        action: 'commerce_service.quote_vendor_approved',
    });
    await this.updateCommerceServiceRequest(quote.requestId, {
        status: 'checkout_pending',
        approvedQuoteId: quoteId,
        recordEvent: false,
    });
    await this.createCommerceServiceContractFromQuote(quoteId, input);
    return updated;
}
