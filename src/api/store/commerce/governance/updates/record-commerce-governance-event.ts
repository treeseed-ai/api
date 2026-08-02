import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,serializeCommerceGovernanceEvent,stringValue } from "../../../../persistence/store.ts";
export async function recordCommerceGovernanceEventMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_governance_events (
				id, actor_type, actor_id, action, object_type, object_id, prior_state, next_state, reason, evidence_json,
				related_order_id, related_offer_id, related_product_id, related_team_id, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        stringValue(input.actorType, 'system'),
        input.actorId ?? null,
        stringValue(input.action, 'commerce.event'),
        stringValue(input.objectType, 'commerce'),
        stringValue(input.objectId, id),
        input.priorState ?? null,
        input.nextState ?? null,
        input.reason ?? null,
        JSON.stringify(input.evidence ?? {}),
        input.relatedOrderId ?? null,
        input.relatedOfferId ?? null,
        input.relatedProductId ?? null,
        input.relatedTeamId ?? null,
        timestamp,
    ]);
    return serializeCommerceGovernanceEvent(await this.first(`SELECT * FROM commerce_governance_events WHERE id = ?`, [id]));
}
