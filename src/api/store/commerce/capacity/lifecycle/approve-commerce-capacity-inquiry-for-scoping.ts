import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function approveCommerceCapacityInquiryForScopingMethod(this: MarketControlPlaneStore, inquiryId, input: any = {}) {
    return this.transitionCommerceCapacityInquiry(inquiryId, 'approved_for_scoping', input);
}
