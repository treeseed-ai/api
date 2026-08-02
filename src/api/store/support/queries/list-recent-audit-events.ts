import { MarketControlPlaneStore,serializeAuditEvent } from "../../../persistence/store.ts";
export async function listRecentAuditEventsMethod(this: MarketControlPlaneStore, limit = 50) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM audit_events
			 ORDER BY created_at DESC LIMIT ?`, [Math.max(1, Math.min(200, Number(limit) || 50))]);
    return rows.map(serializeAuditEvent);
}
