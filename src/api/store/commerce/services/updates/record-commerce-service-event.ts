import { randomUUID } from 'node:crypto';
import { COMMERCE_SERVICE_EVENT_TYPE_SET,enumValue,isoNow,MarketControlPlaneStore,serializeCommerceServiceEvent } from "../../../../persistence/store.ts";
export async function recordCommerceServiceEventMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const eventType = enumValue(input.eventType, COMMERCE_SERVICE_EVENT_TYPE_SET, 'manual_update');
    await this.run(`INSERT INTO commerce_service_events (
				id, request_id, quote_id, contract_id, event_type, actor_type, actor_id,
				prior_state, next_state, message, evidence_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.requestId,
        input.quoteId ?? null,
        input.contractId ?? null,
        eventType,
        input.actorType ?? 'system',
        input.actorId ?? null,
        input.priorState ?? null,
        input.nextState ?? null,
        input.message ?? null,
        JSON.stringify(input.evidence ?? {}),
        timestamp,
    ]);
    return serializeCommerceServiceEvent(await this.first(`SELECT * FROM commerce_service_events WHERE id = ? LIMIT 1`, [id]));
}
