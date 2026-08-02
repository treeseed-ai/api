import { randomUUID } from 'node:crypto';
import { enumValue,isoNow,MarketControlPlaneStore,serializeCommerceSuccessionEvent,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceSuccessionEventMethod(this: MarketControlPlaneStore, productId, input: any = {}) {
    await this.ensureInitialized();
    const product = await this.getCommerceProduct(productId);
    if (!product)
        return null;
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_succession_events (
				id, product_id, ownership_record_id, stewardship_assignment_id, successor_type, successor_id, event_type,
				status, reason, evidence_json, effective_at, created_by_type, created_by_id, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        productId,
        input.ownershipRecordId ?? product.ownershipRecordId ?? null,
        input.stewardshipAssignmentId ?? null,
        stringValue(input.successorType, 'team'),
        stringValue(input.successorId, product.sellerTeamId),
        enumValue(input.eventType, new Set(['successor_named', 'successor_accepted', 'succession_triggered', 'succession_completed', 'succession_canceled']), 'successor_named'),
        enumValue(input.status, new Set(['draft', 'submitted', 'approved', 'rejected', 'canceled', 'superseded']), 'submitted'),
        input.reason ?? null,
        JSON.stringify(input.evidence ?? {}),
        input.effectiveAt ?? null,
        stringValue(input.createdByType ?? input.actorType, 'user'),
        stringValue(input.createdById ?? input.actorId, 'system'),
        JSON.stringify(input.metadata ?? {}),
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? input.createdByType ?? 'system',
        actorId: input.actorId ?? input.createdById ?? null,
        action: 'commerce_succession_event.created',
        objectType: 'commerce_succession_event',
        objectId: id,
        nextState: input.status ?? 'submitted',
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedProductId: productId,
        relatedTeamId: product.sellerTeamId,
    });
    return serializeCommerceSuccessionEvent(await this.first(`SELECT * FROM commerce_succession_events WHERE id = ?`, [id]));
}
