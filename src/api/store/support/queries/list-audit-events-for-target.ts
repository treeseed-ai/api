import { ControlPlaneStore,serializeAuditEvent } from "../../../persistence/store.ts";
export async function listAuditEventsForTargetMethod(this: ControlPlaneStore, targetType, targetId, limit = 50) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM audit_events
			 WHERE target_type = ? AND target_id = ?
			 ORDER BY created_at DESC LIMIT ?`, [targetType, targetId, Math.max(1, Math.min(200, Number(limit) || 50))]);
    return rows.map(serializeAuditEvent);
}
