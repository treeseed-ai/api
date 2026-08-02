import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function updateCommerceEntitlementFulfillmentMethod(this: MarketControlPlaneStore, entitlementId, input: any = {}) {
    const existing = await this.getCommerceEntitlement(entitlementId);
    if (!existing)
        return null;
    return this.updateCommerceEntitlementStatus(entitlementId, {
        status: input.status ?? existing.status,
        fulfillmentArtifactRefs: input.fulfillmentArtifactRefs ?? existing.fulfillmentArtifactRefs ?? [],
        metadata: input.metadata ?? existing.metadata ?? {},
        action: 'commerce_entitlement.fulfilled',
    });
}
