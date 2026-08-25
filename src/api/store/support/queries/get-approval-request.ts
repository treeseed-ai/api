import { ControlPlaneStore,serializeApprovalRequest } from "../../../persistence/store.ts";
export async function getApprovalRequestMethod(this: ControlPlaneStore, id) {
    await this.ensureInitialized();
    return serializeApprovalRequest(await this.first(`SELECT * FROM approval_requests WHERE id = ? LIMIT 1`, [id]));
}
