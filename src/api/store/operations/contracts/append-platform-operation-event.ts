import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,serializePlatformOperationEvent } from "../../../persistence/store.ts";
export async function appendPlatformOperationEventMethod(this: ControlPlaneStore, operationId, kind, data: any = {}) {
    await this.ensureInitialized();
    const row = await this.first(`SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM platform_operation_events WHERE operation_id = ?`, [operationId]);
    const seq = Number(row?.next_seq ?? 1);
    const timestamp = isoNow();
    const id = randomUUID();
    await this.run(`INSERT INTO platform_operation_events (id, operation_id, seq, kind, data_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`, [id, operationId, seq, kind, JSON.stringify(data ?? {}), timestamp]);
    return serializePlatformOperationEvent(await this.first(`SELECT * FROM platform_operation_events WHERE id = ?`, [id]));
}
