import { ControlPlaneStore,serializePlatformOperation } from "../../../../persistence/store.ts";
import type { PlatformOperationRow } from "../../../support/operations/operations.ts";
export async function findPlatformOperationByIdMethod(this: ControlPlaneStore, operationId: string) {
    await this.ensureInitialized();
    return serializePlatformOperation(await this.first<PlatformOperationRow>(`SELECT * FROM platform_operations WHERE id = ?`, [operationId]));
}
