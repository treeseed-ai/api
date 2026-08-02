import { randomUUID } from 'node:crypto';
import { enumValue,isoNow,MarketControlPlaneStore,numberValue,serializeCommerceContribution,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceContributionMethod(this: MarketControlPlaneStore, productId, input: any = {}) {
    await this.ensureInitialized();
    const product = await this.getCommerceProduct(productId);
    if (!product)
        return null;
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_contributions (
				id, product_id, product_version_id, contributor_type, contributor_id, display_name, role, summary,
				attribution_visibility, agreement_ref, benefit_weight, effective_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        productId,
        input.productVersionId ?? null,
        stringValue(input.contributorType, 'team'),
        input.contributorId ?? product.sellerTeamId,
        input.displayName ?? null,
        stringValue(input.role, 'contributor'),
        input.summary ?? null,
        enumValue(input.attributionVisibility, new Set(['public', 'buyer', 'vendor', 'private']), 'public'),
        input.agreementRef ?? null,
        numberValue(input.benefitWeight, null),
        input.effectiveAt ?? timestamp,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    return serializeCommerceContribution(await this.first(`SELECT * FROM commerce_contributions WHERE id = ?`, [id]));
}
