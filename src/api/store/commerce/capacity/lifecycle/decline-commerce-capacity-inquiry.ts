import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function declineCommerceCapacityInquiryMethod(this: MarketControlPlaneStore, inquiryId, input: any = {}) {
    return this.transitionCommerceCapacityInquiry(inquiryId, 'declined', input);
}
