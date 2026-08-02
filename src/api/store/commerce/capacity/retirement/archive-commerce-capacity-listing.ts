import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function archiveCommerceCapacityListingMethod(this: MarketControlPlaneStore, listingId, input: any = {}, capacity) {
    return this.transitionCommerceCapacityListing(listingId, 'archived', input, capacity);
}
