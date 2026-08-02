import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function submitCommerceCapacityListingMethod(this: MarketControlPlaneStore, listingId, input: any = {}, capacity) {
    return this.transitionCommerceCapacityListing(listingId, 'submitted', input, capacity);
}
