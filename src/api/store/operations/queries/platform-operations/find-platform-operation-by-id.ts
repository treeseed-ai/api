import { MarketControlPlaneStore,serializePlatformOperation } from "../../../../persistence/store.ts";
export async function findPlatformOperationByIdMethod(this: MarketControlPlaneStore, operationId) {
    await this.ensureInitialized();
    return serializePlatformOperation(await this.first(`SELECT * FROM platform_operations WHERE id = ?`, [operationId]));
}
