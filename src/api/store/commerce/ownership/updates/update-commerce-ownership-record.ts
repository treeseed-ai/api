import { isoNow,MarketControlPlaneStore,serializeCommerceOwnershipRecord } from "../../../../persistence/store.ts";
export async function updateCommerceOwnershipRecordMethod(this: MarketControlPlaneStore, ownershipRecordId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.first(`SELECT * FROM commerce_ownership_records WHERE id = ?`, [ownershipRecordId]);
    if (!existing)
        return null;
    const timestamp = isoNow();
    await this.run(`UPDATE commerce_ownership_records
			 SET public_summary = ?, buyer_visible = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        input.publicSummary === undefined ? existing.public_summary : input.publicSummary,
        input.buyerVisible === undefined ? existing.buyer_visible : input.buyerVisible ? 1 : 0,
        input.metadata === undefined ? existing.metadata_json : JSON.stringify(input.metadata ?? {}),
        timestamp,
        ownershipRecordId,
    ]);
    const updated = serializeCommerceOwnershipRecord(await this.first(`SELECT * FROM commerce_ownership_records WHERE id = ?`, [ownershipRecordId]));
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: 'commerce_ownership.record.updated',
        objectType: 'commerce_ownership_record',
        objectId: ownershipRecordId,
        priorState: existing.buyer_visible ? 'buyer_visible' : 'private',
        nextState: updated.buyerVisible ? 'buyer_visible' : 'private',
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedProductId: existing.product_id,
        relatedTeamId: existing.seller_team_id,
    });
    return updated;
}
