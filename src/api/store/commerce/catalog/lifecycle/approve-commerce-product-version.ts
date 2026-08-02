import { isoNow,MarketControlPlaneStore,serializeCommerceProductVersion } from "../../../../persistence/store.ts";
export async function approveCommerceProductVersionMethod(this: MarketControlPlaneStore, versionId, input: any = {}) {
    await this.ensureInitialized();
    const existing = serializeCommerceProductVersion(await this.first(`SELECT * FROM commerce_product_versions WHERE id = ? LIMIT 1`, [versionId]));
    if (!existing)
        return null;
    const product = await this.getCommerceProduct(existing.productId);
    if (product?.status !== 'approved') {
        const error: Error & Record<string, any> = new Error('Product must be approved before version approval.');
        error.status = 409;
        throw error;
    }
    let catalogArtifact = null;
    if (existing.artifactKey && product.catalogItemId) {
        catalogArtifact = await this.upsertCatalogArtifactVersion(product.sellerTeamId, product.catalogItemId, {
            kind: `${product.kind}_artifact`,
            version: existing.version,
            contentKey: existing.artifactKey,
            manifestKey: existing.manifestKey,
            metadata: {
                ...(existing.metadata ?? {}),
                commerceProductId: product.id,
                commerceProductVersionId: existing.id,
                integrity: existing.integrity,
            },
            publishedAt: input.publishedAt ?? isoNow(),
        });
    }
    const timestamp = isoNow();
    await this.run(`UPDATE commerce_product_versions
			 SET status = ?, catalog_artifact_version_id = ?, published_at = ?, updated_at = ?
			 WHERE id = ?`, ['approved', catalogArtifact?.id ?? existing.catalogArtifactVersionId, input.publishedAt ?? timestamp, timestamp, versionId]);
    await this.run(`UPDATE commerce_products SET current_version_id = ?, updated_at = ? WHERE id = ?`, [versionId, timestamp, product.id]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'operator',
        actorId: input.actorId ?? null,
        action: 'product_version.approve',
        objectType: 'commerce_product_version',
        objectId: versionId,
        priorState: existing.status,
        nextState: 'approved',
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedProductId: product.id,
        relatedTeamId: product.sellerTeamId,
    });
    return serializeCommerceProductVersion(await this.first(`SELECT * FROM commerce_product_versions WHERE id = ?`, [versionId]));
}
