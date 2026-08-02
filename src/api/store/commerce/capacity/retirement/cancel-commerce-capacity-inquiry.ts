import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function cancelCommerceCapacityInquiryMethod(this: MarketControlPlaneStore, inquiryId, input: any = {}) {
    const existing = await this.getCommerceCapacityListingInquiry(inquiryId);
    if (existing && !['requested', 'reviewing'].includes(existing.status)) {
        const error: Error & Record<string, any> = new Error('Capacity inquiry can only be canceled before seller approval or decline.');
        error.status = 409;
        throw error;
    }
    return this.transitionCommerceCapacityInquiry(inquiryId, 'canceled', input);
}
