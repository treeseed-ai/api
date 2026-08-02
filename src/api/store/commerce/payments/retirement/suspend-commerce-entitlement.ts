import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function suspendCommerceEntitlementMethod(this: MarketControlPlaneStore, entitlementId, input: any = {}) {
    return this.updateCommerceEntitlementStatus(entitlementId, { ...input, status: 'past_due', action: 'commerce_entitlement.suspended' });
}
