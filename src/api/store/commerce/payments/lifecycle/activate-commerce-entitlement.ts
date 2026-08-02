import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function activateCommerceEntitlementMethod(this: MarketControlPlaneStore, entitlementId, input: any = {}) {
    return this.updateCommerceEntitlementStatus(entitlementId, { ...input, status: 'active', action: 'commerce_entitlement.activated' });
}
