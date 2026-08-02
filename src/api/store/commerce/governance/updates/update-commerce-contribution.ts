import { enumValue,isoNow,MarketControlPlaneStore,numberValue,serializeCommerceContribution } from "../../../../persistence/store.ts";
export async function updateCommerceContributionMethod(this: MarketControlPlaneStore, contributionId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.first(`SELECT * FROM commerce_contributions WHERE id = ?`, [contributionId]);
    if (!existing)
        return null;
    const timestamp = isoNow();
    await this.run(`UPDATE commerce_contributions
			 SET summary = ?, attribution_visibility = ?, benefit_weight = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        input.summary === undefined ? existing.summary : input.summary,
        input.attributionVisibility === undefined ? existing.attribution_visibility : enumValue(input.attributionVisibility, new Set(['public', 'buyer', 'vendor', 'private']), existing.attribution_visibility),
        input.benefitWeight === undefined ? existing.benefit_weight : numberValue(input.benefitWeight, null),
        input.metadata === undefined ? existing.metadata_json : JSON.stringify(input.metadata ?? {}),
        timestamp,
        contributionId,
    ]);
    const updated = serializeCommerceContribution(await this.first(`SELECT * FROM commerce_contributions WHERE id = ?`, [contributionId]));
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: 'commerce_contribution.updated',
        objectType: 'commerce_contribution',
        objectId: contributionId,
        priorState: existing.attribution_visibility,
        nextState: updated.attributionVisibility,
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedProductId: existing.product_id,
    });
    return updated;
}
