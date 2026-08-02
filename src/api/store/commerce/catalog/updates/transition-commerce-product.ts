import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function transitionCommerceProductMethod(this: MarketControlPlaneStore, productId, nextState, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceProduct(productId);
    if (!existing)
        return null;
    const timestamp = isoNow();
    await this.run(`UPDATE commerce_products SET status = ?, updated_at = ? WHERE id = ?`, [nextState, timestamp, productId]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: `product.${nextState}`,
        objectType: 'commerce_product',
        objectId: productId,
        priorState: existing.status,
        nextState,
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedProductId: productId,
        relatedTeamId: existing.sellerTeamId,
    });
    return this.getCommerceProduct(productId);
}
