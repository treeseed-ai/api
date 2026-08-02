import { randomUUID } from 'node:crypto';
import { COMMERCE_OWNERSHIP_MODEL_SET,enumValue,isoNow,MarketControlPlaneStore,serializeCommerceOwnershipRecord,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceOwnershipRecordMethod(this: MarketControlPlaneStore, productId, input: any = {}) {
    await this.ensureInitialized();
    const product = await this.getCommerceProduct(productId);
    if (!product)
        return null;
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_ownership_records (
				id, product_id, model, canonical_owner_type, canonical_owner_id, seller_team_id, steward_team_id,
				governance_policy_id, public_summary, buyer_visible, effective_at, superseded_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        productId,
        enumValue(input.model, COMMERCE_OWNERSHIP_MODEL_SET, product.ownershipModel),
        stringValue(input.canonicalOwnerType, 'team'),
        input.canonicalOwnerId ?? product.sellerTeamId,
        input.sellerTeamId ?? product.sellerTeamId,
        input.stewardTeamId ?? product.sellerTeamId,
        input.governancePolicyId ?? null,
        input.publicSummary ?? null,
        input.buyerVisible === false ? 0 : 1,
        input.effectiveAt ?? timestamp,
        input.supersededAt ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    return serializeCommerceOwnershipRecord(await this.first(`SELECT * FROM commerce_ownership_records WHERE id = ?`, [id]));
}
