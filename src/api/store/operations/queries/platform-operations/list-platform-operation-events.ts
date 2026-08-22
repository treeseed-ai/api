import { ControlPlaneStore,serializePlatformOperationEvent } from "../../../../persistence/store.ts";
export async function listPlatformOperationEventsMethod(this: ControlPlaneStore, operationId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM platform_operation_events WHERE operation_id = ? ORDER BY seq ASC`, [operationId]);
    return rows.map(serializePlatformOperationEvent);
}
