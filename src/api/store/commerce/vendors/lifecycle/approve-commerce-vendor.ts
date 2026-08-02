import { COMMERCE_VENDOR_TRUST_LEVEL_SET,enumValue,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function approveCommerceVendorMethod(this: MarketControlPlaneStore, vendorId, input: any = {}) {
    const existing = await this.getCommerceVendor(vendorId);
    if (!existing)
        return null;
    const trustLevel = enumValue(input.trustLevel, COMMERCE_VENDOR_TRUST_LEVEL_SET, 'verified_seller');
    const vendor = await this.updateCommerceVendor(vendorId, {
        ...input,
        status: 'approved',
        trustLevel,
        salesEnabled: input.salesEnabled !== false,
        serviceSalesEnabled: input.serviceSalesEnabled === true,
        capacityListingsEnabled: input.capacityListingsEnabled === true,
    });
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'operator',
        actorId: input.actorId ?? null,
        action: 'vendor.approve',
        objectType: 'commerce_vendor',
        objectId: vendorId,
        priorState: existing.status,
        nextState: 'approved',
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedTeamId: existing.teamId,
    });
    return vendor;
}
