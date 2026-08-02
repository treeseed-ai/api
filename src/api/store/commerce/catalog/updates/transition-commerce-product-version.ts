import { isoNow,MarketControlPlaneStore,serializeCommerceProductVersion } from "../../../../persistence/store.ts";
export async function transitionCommerceProductVersionMethod(this: MarketControlPlaneStore, versionId, nextState, input: any = {}) {
    await this.ensureInitialized();
    const existing = serializeCommerceProductVersion(await this.first(`SELECT * FROM commerce_product_versions WHERE id = ? LIMIT 1`, [versionId]));
    if (!existing)
        return null;
    await this.run(`UPDATE commerce_product_versions SET status = ?, updated_at = ? WHERE id = ?`, [nextState, isoNow(), versionId]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: `product_version.${nextState}`,
        objectType: 'commerce_product_version',
        objectId: versionId,
        priorState: existing.status,
        nextState,
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedProductId: existing.productId,
    });
    return serializeCommerceProductVersion(await this.first(`SELECT * FROM commerce_product_versions WHERE id = ?`, [versionId]));
}
