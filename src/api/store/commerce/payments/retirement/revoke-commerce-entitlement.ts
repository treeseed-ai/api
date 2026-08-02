import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function revokeCommerceEntitlementMethod(this: MarketControlPlaneStore, entitlementId, input: any = {}) {
    return this.updateCommerceEntitlementStatus(entitlementId, { ...input, status: 'revoked', action: 'commerce_entitlement.revoked' });
}
