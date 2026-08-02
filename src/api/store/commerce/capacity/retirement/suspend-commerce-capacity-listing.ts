import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function suspendCommerceCapacityListingMethod(this: MarketControlPlaneStore, listingId, input: any = {}, capacity) {
    return this.transitionCommerceCapacityListing(listingId, 'suspended', { ...input, marketAdmin: true }, capacity);
}
