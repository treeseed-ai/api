import { ControlPlaneStore,serializeControlPlaneOperationRunner } from "../../../../persistence/store.ts";
export async function findControlPlaneOperationRunnerByIdMethod(this: ControlPlaneStore, runnerId) {
    await this.ensureInitialized();
    return serializeControlPlaneOperationRunner(await this.first(`SELECT * FROM control_plane_operation_runners WHERE id = ?`, [runnerId]));
}
