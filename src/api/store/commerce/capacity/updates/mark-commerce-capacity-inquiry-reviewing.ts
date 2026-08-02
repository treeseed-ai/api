import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function markCommerceCapacityInquiryReviewingMethod(this: MarketControlPlaneStore, inquiryId, input: any = {}) {
    return this.transitionCommerceCapacityInquiry(inquiryId, 'reviewing', input);
}
