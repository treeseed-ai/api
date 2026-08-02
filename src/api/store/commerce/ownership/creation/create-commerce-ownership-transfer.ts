import { randomUUID } from 'node:crypto';
import { enumValue,isoNow,MarketControlPlaneStore,serializeCommerceOwnershipTransfer,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceOwnershipTransferMethod(this: MarketControlPlaneStore, productId, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const product = await this.getCommerceProduct(productId);
    if (!product)
        return null;
    const status = enumValue(input.status, new Set(['draft', 'submitted']), 'draft');
    await this.run(`INSERT INTO commerce_ownership_transfers (
				id, product_id, from_ownership_record_id, to_ownership_record_id, status, reason, approval_evidence_json,
				buyer_visible_impact, effective_at, requested_by_type, requested_by_id, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        productId,
        input.fromOwnershipRecordId,
        input.toOwnershipRecordId,
        status,
        stringValue(input.reason, 'Ownership transfer'),
        JSON.stringify(input.approvalEvidence ?? {}),
        input.buyerVisibleImpact ?? null,
        input.effectiveAt ?? timestamp,
        stringValue(input.requestedByType ?? input.actorType, 'user'),
        stringValue(input.requestedById ?? input.actorId, 'system'),
        JSON.stringify(input.metadata ?? {}),
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? input.requestedByType ?? 'system',
        actorId: input.actorId ?? input.requestedById ?? null,
        action: 'commerce_ownership_transfer.created',
        objectType: 'commerce_ownership_transfer',
        objectId: id,
        nextState: status,
        reason: input.reason ?? null,
        evidence: input.approvalEvidence ?? {},
        relatedProductId: productId,
        relatedTeamId: product.sellerTeamId,
    });
    return serializeCommerceOwnershipTransfer(await this.first(`SELECT * FROM commerce_ownership_transfers WHERE id = ?`, [id]));
}
