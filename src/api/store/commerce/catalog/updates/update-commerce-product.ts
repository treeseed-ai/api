import { COMMERCE_OWNERSHIP_MODEL_SET,COMMERCE_PRODUCT_KIND_SET,COMMERCE_VISIBILITY_SET,enumValue,isoNow,MarketControlPlaneStore,safeIdPart,stringValue } from "../../../../persistence/store.ts";
export async function updateCommerceProductMethod(this: MarketControlPlaneStore, productId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceProduct(productId);
    if (!existing)
        return null;
    if (!['draft', 'rejected'].includes(existing.status)) {
        const error: Error & Record<string, any> = new Error('Approved or submitted products cannot be edited through draft update.');
        error.status = 409;
        throw error;
    }
    const timestamp = isoNow();
    await this.run(`UPDATE commerce_products
			 SET kind = ?, slug = ?, title = ?, summary = ?, description = ?, visibility = ?, ownership_model = ?,
			     support_policy = ?, license = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        enumValue(input.kind, COMMERCE_PRODUCT_KIND_SET, existing.kind),
        safeIdPart(input.slug ?? existing.slug, existing.slug),
        stringValue(input.title, existing.title),
        input.summary === undefined ? existing.summary : input.summary,
        input.description === undefined ? existing.description : input.description,
        enumValue(input.visibility, COMMERCE_VISIBILITY_SET, existing.visibility),
        enumValue(input.ownershipModel, COMMERCE_OWNERSHIP_MODEL_SET, existing.ownershipModel),
        input.supportPolicy === undefined ? existing.supportPolicy : input.supportPolicy,
        input.license === undefined ? existing.license : input.license,
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        timestamp,
        productId,
    ]);
    return this.getCommerceProduct(productId);
}
