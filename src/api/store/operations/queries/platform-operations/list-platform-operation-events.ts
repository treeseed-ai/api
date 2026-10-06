import { ControlPlaneStore,serializePlatformOperationEvent } from "../../../../persistence/store.ts";
import type { PlatformOperationEventRow } from "../../../support/operations/operations.ts";
export async function listPlatformOperationEventsMethod(this: ControlPlaneStore, operationId: string) {
    await this.ensureInitialized();
    const rows = await this.all<PlatformOperationEventRow>(`SELECT * FROM platform_operation_events WHERE operation_id = ? ORDER BY seq ASC`, [operationId]);
    return rows.map(serializePlatformOperationEvent);
}
