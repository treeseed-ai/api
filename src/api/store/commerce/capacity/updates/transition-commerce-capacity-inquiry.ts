import { COMMERCE_CAPACITY_INQUIRY_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function transitionCommerceCapacityInquiryMethod(this: MarketControlPlaneStore, inquiryId, nextState, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceCapacityListingInquiry(inquiryId);
    if (!existing)
        return null;
    const state = enumValue(nextState, COMMERCE_CAPACITY_INQUIRY_STATUS_SET, existing.status);
    await this.run(`UPDATE commerce_capacity_listing_inquiries
			 SET status = ?, governance_evidence_json = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        state,
        JSON.stringify(input.evidence ?? existing.governanceEvidence ?? {}),
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        isoNow(),
        inquiryId,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: input.action ?? `commerce_capacity_inquiry.${state}`,
        objectType: 'commerce_capacity_listing_inquiry',
        objectId: inquiryId,
        priorState: existing.status,
        nextState: state,
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedProductId: existing.productId,
        relatedTeamId: existing.sellerTeamId,
    });
    return this.getCommerceCapacityListingInquiry(inquiryId);
}
