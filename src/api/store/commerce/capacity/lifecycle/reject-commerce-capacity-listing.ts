import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function rejectCommerceCapacityListingMethod(this: MarketControlPlaneStore, listingId, input: any = {}, capacity) {
    return this.transitionCommerceCapacityListing(listingId, 'rejected', { ...input, marketAdmin: true }, capacity);
}
