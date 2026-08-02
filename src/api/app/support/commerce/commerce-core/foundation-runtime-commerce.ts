import { ensurePrincipal,jsonError,optionalTrimmedString,principalIsSeedAdmin,requireTeamAccess } from '../../index.ts';
export async function requireVendorOrderManager(c, store, order) {
    if (!order?.sellerTeamId)
        return { response: jsonError(c, 404, 'Commerce order does not have a seller team.') };
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    if (principalIsSeedAdmin(auth.principal))
        return auth;
    const access = await requireTeamAccess(c, store, order.sellerTeamId, 'teams:manage:team');
    return access;
}
export function remainingRefundableAmount(order, orderItem = null) {
    const target = orderItem ?? order;
    return Math.max(0, Number(target.totalAmount ?? 0) - Number(target.refundedAmount ?? 0));
}
export async function resolveOrderItemForRefund(store, order, orderItemId) {
    if (!orderItemId)
        return null;
    const items = await store.listCommerceOrderItems(order.id);
    const item = items.find((entry) => entry.id === orderItemId);
    if (!item) {
        const error: Error & Record<string, any> = new Error('Refund order item does not belong to this order.');
        error.status = 404;
        throw error;
    }
    return item;
}
export async function resolveFulfillmentArtifact({ store, orderItem, body }) {
    const product = await store.getCommerceProduct(orderItem.productId);
    const version = orderItem.productVersionId ? await store.getCommerceProductVersionById(orderItem.productVersionId) : null;
    const catalogArtifactVersionId = optionalTrimmedString(body.catalogArtifactVersionId) ?? version?.catalogArtifactVersionId ?? null;
    const artifact = catalogArtifactVersionId ? await store.getCatalogArtifactVersionById(catalogArtifactVersionId) : null;
    const catalogItemId = product?.catalogItemId ?? artifact?.itemId ?? null;
    const artifactRefs = Array.isArray(body.artifactRefs) ? body.artifactRefs.filter((entry) => entry && typeof entry === 'object') : [];
    if (artifact) {
        artifactRefs.push({
            catalogArtifactVersionId: artifact.id,
            itemId: artifact.itemId,
            version: artifact.version,
            contentKey: artifact.contentKey,
        });
    }
    const deliveryRefs = artifact
        ? [{
                type: 'catalog_artifact_download',
                catalogItemId: artifact.itemId,
                version: artifact.version,
                path: `/v1/catalog/${encodeURIComponent(artifact.itemId)}/artifacts/${encodeURIComponent(artifact.version)}/download`,
            }]
        : artifactRefs;
    return { product, version, artifact, catalogItemId, artifactRefs, deliveryRefs };
}
