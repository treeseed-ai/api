import { COMMERCE_ENTITLEMENT_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function updateCommerceEntitlementStatusMethod(this: MarketControlPlaneStore, entitlementId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceEntitlement(entitlementId);
    if (!existing)
        return null;
    const status = enumValue(input.status, COMMERCE_ENTITLEMENT_STATUS_SET, existing.status);
    await this.run(`UPDATE commerce_entitlements
			 SET status = ?, starts_at = ?, ends_at = ?, renewal_state = ?, fulfillment_artifact_refs_json = ?,
			     metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        status,
        input.startsAt === undefined ? existing.startsAt : input.startsAt,
        input.endsAt === undefined ? existing.endsAt : input.endsAt,
        input.renewalState ?? existing.renewalState,
        JSON.stringify(input.fulfillmentArtifactRefs ?? existing.fulfillmentArtifactRefs ?? []),
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        isoNow(),
        entitlementId,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: input.action ?? `commerce_entitlement.${status}`,
        objectType: 'commerce_entitlement',
        objectId: entitlementId,
        priorState: existing.status,
        nextState: status,
        relatedOrderId: existing.orderId,
        relatedOfferId: existing.offerId,
        relatedProductId: existing.productId,
        relatedTeamId: existing.buyerTeamId ?? existing.sellerTeamId,
    });
    return this.getCommerceEntitlement(entitlementId);
}
