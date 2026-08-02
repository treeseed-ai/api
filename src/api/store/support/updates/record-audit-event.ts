import { randomUUID } from 'node:crypto';
import { redactSensitiveValue } from "../../../../security/redact-sensitive-value.ts";
import { isoNow,MarketControlPlaneStore,serializeAuditEvent } from "../../../persistence/store.ts";
export async function recordAuditEventMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = input.createdAt ?? isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO audit_events (id, actor_type, actor_id, event_type, target_type, target_id, data_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`, [
        id,
        input.actorType ?? input.actor?.type ?? 'system',
        input.actorId ?? input.actor?.id ?? null,
        input.eventType,
        input.targetType ?? null,
        input.targetId ?? null,
        JSON.stringify(redactSensitiveValue(input.data ?? {})),
        timestamp,
    ]);
    return serializeAuditEvent(await this.first(`SELECT * FROM audit_events WHERE id = ?`, [id]));
}
