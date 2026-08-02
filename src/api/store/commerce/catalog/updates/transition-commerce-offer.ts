import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function transitionCommerceOfferMethod(this: MarketControlPlaneStore, offerId, nextState, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceOffer(offerId);
    if (!existing)
        return null;
    await this.run(`UPDATE commerce_offers SET status = ?, updated_at = ? WHERE id = ?`, [nextState, isoNow(), offerId]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: `offer.${nextState}`,
        objectType: 'commerce_offer',
        objectId: offerId,
        priorState: existing.status,
        nextState,
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedOfferId: offerId,
        relatedProductId: existing.productId,
        relatedTeamId: existing.sellerTeamId,
    });
    return this.getCommerceOffer(offerId);
}
