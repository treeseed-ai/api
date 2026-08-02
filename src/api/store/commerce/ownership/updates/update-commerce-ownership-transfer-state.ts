import { isoNow,MarketControlPlaneStore,parseJson,serializeCommerceOwnershipTransfer } from "../../../../persistence/store.ts";
export async function updateCommerceOwnershipTransferStateMethod(this: MarketControlPlaneStore, transferId, nextState, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.first(`SELECT * FROM commerce_ownership_transfers WHERE id = ?`, [transferId]);
    if (!existing)
        return null;
    const product = await this.getCommerceProduct(existing.product_id);
    const timestamp = isoNow();
    const approvalFields = nextState === 'approved'
        ? `, approved_by_type = ?, approved_by_id = ?, approved_at = ?`
        : nextState === 'rejected'
            ? `, rejected_at = ?`
            : '';
    const params = [
        nextState,
        JSON.stringify(input.evidence ?? parseJson(existing.approval_evidence_json, {})),
        input.reason ?? existing.reason,
        ...(nextState === 'approved'
            ? [input.actorType ?? 'system', input.actorId ?? 'system', timestamp]
            : nextState === 'rejected'
                ? [timestamp]
                : []),
        transferId,
    ];
    await this.run(`UPDATE commerce_ownership_transfers
			 SET status = ?, approval_evidence_json = ?, reason = ?${approvalFields}
			 WHERE id = ?`, params);
    if (nextState === 'approved') {
        await this.run(`UPDATE commerce_ownership_records SET superseded_at = ?, updated_at = ? WHERE id = ? AND superseded_at IS NULL`, [timestamp, timestamp, existing.from_ownership_record_id]);
        await this.setCurrentCommerceOwnershipRecord(existing.product_id, existing.to_ownership_record_id);
    }
    const updated = serializeCommerceOwnershipTransfer(await this.first(`SELECT * FROM commerce_ownership_transfers WHERE id = ?`, [transferId]));
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: `commerce_ownership_transfer.${nextState}`,
        objectType: 'commerce_ownership_transfer',
        objectId: transferId,
        priorState: existing.status ?? 'draft',
        nextState,
        reason: input.reason ?? existing.reason,
        evidence: input.evidence ?? {},
        relatedProductId: existing.product_id,
        relatedTeamId: product?.sellerTeamId ?? null,
    });
    return updated;
}
