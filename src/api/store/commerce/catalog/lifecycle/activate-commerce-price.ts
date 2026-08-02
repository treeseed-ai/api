import { isoNow,MarketControlPlaneStore,serializeCommercePrice } from "../../../../persistence/store.ts";
export async function activateCommercePriceMethod(this: MarketControlPlaneStore, priceId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommercePrice(priceId);
    if (!existing)
        return null;
    await this.run(`UPDATE commerce_prices SET status = 'archived', updated_at = ? WHERE offer_id = ? AND status = 'active'`, [isoNow(), existing.offerId]);
    await this.run(`UPDATE commerce_prices SET status = 'active', updated_at = ? WHERE id = ?`, [isoNow(), priceId]);
    await this.run(`UPDATE commerce_offers SET active_price_id = ?, updated_at = ? WHERE id = ?`, [priceId, isoNow(), existing.offerId]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'operator',
        actorId: input.actorId ?? null,
        action: 'price.activate',
        objectType: 'commerce_price',
        objectId: priceId,
        priorState: existing.status,
        nextState: 'active',
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedOfferId: existing.offerId,
    });
    return serializeCommercePrice(await this.first(`SELECT * FROM commerce_prices WHERE id = ?`, [priceId]));
}
