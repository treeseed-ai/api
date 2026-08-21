import { ControlPlaneStore,serializeMarketOperationRunner } from "../../../../persistence/store.ts";
export async function findMarketOperationRunnerByIdMethod(this: ControlPlaneStore, runnerId) {
    await this.ensureInitialized();
    return serializeMarketOperationRunner(await this.first(`SELECT * FROM control_plane_operation_runners WHERE id = ?`, [runnerId]));
}
