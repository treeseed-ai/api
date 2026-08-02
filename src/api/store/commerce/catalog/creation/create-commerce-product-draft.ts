import { randomUUID } from 'node:crypto';
import { COMMERCE_OWNERSHIP_MODEL_SET,COMMERCE_PRODUCT_KIND_SET,COMMERCE_VISIBILITY_SET,enumValue,isoNow,MarketControlPlaneStore,requireEnumValue,safeIdPart,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceProductDraftMethod(this: MarketControlPlaneStore, teamId, input: any = {}) {
    await this.ensureInitialized();
    const vendor = await this.getCommerceVendorForTeam(teamId);
    if (!vendor) {
        const error: Error & Record<string, any> = new Error('Commerce vendor capability is required before creating products.');
        error.status = 409;
        throw error;
    }
    const kind = requireEnumValue(input.kind, COMMERCE_PRODUCT_KIND_SET, 'commerce product kind');
    const title = stringValue(input.title, '');
    if (!title) {
        const error: Error & Record<string, any> = new Error('Product title is required.');
        error.status = 400;
        throw error;
    }
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const slug = safeIdPart(input.slug ?? title, id);
    const ownershipModel = enumValue(input.ownershipModel, COMMERCE_OWNERSHIP_MODEL_SET, 'team_owned');
    await this.run(`INSERT INTO commerce_products (
				id, vendor_id, seller_team_id, kind, slug, title, summary, description, status, visibility, catalog_item_id,
				current_version_id, ownership_model, ownership_record_id, support_policy, license, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        vendor.id,
        teamId,
        kind,
        slug,
        title,
        input.summary ?? null,
        input.description ?? null,
        'draft',
        enumValue(input.visibility, COMMERCE_VISIBILITY_SET, 'private'),
        null,
        null,
        ownershipModel,
        null,
        input.supportPolicy ?? null,
        input.license ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    const ownership = await this.createCommerceOwnershipRecord(id, {
        ...(input.ownership ?? {}),
        model: input.ownership?.model ?? ownershipModel,
        canonicalOwnerType: input.ownership?.canonicalOwnerType ?? 'team',
        canonicalOwnerId: input.ownership?.canonicalOwnerId ?? teamId,
        sellerTeamId: teamId,
        stewardTeamId: input.ownership?.stewardTeamId ?? teamId,
        publicSummary: input.ownership?.publicSummary ?? 'Owned and stewarded by the seller team.',
        buyerVisible: input.ownership?.buyerVisible ?? true,
        effectiveAt: input.ownership?.effectiveAt ?? timestamp,
    });
    await this.setCurrentCommerceOwnershipRecord(id, ownership.id);
    return this.getCommerceProduct(id);
}
