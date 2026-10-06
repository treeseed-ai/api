import { ControlPlaneStore,serializeControlPlaneOperationRunner } from "../../../../persistence/store.ts";
import type { ControlPlaneOperationRunnerRow } from "../../../support/operations/operations.ts";
export async function findControlPlaneOperationRunnerByIdMethod(this: ControlPlaneStore, runnerId: string) {
    await this.ensureInitialized();
    return serializeControlPlaneOperationRunner(await this.first<ControlPlaneOperationRunnerRow>(`SELECT * FROM control_plane_operation_runners WHERE id = ?`, [runnerId]));
}
