import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function listCommerceVendorSalesEntitlementsMethod(this: MarketControlPlaneStore, teamId, filters: any = {}) {
    await this.ensureInitialized();
    return this.listCommerceEntitlements(null, { ...filters, sellerTeamId: teamId });
}
