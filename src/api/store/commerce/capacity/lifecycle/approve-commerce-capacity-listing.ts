import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function approveCommerceCapacityListingMethod(this: MarketControlPlaneStore, listingId, input: any = {}, capacity) {
    return this.transitionCommerceCapacityListing(listingId, 'approved', { ...input, marketAdmin: true }, capacity);
}
