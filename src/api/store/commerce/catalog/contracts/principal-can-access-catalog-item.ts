import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function principalCanAccessCatalogItemMethod(this: MarketControlPlaneStore, principal, item) {
    if (!item)
        return false;
    if (item.visibility === 'public') {
        return item.listingEnabled !== false;
    }
    return this.principalCanAccessTeam(principal, item.teamId);
}
