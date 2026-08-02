import { MarketControlPlaneStore,serializeApprovalRequest } from "../../../persistence/store.ts";
export async function getApprovalRequestMethod(this: MarketControlPlaneStore, id) {
    await this.ensureInitialized();
    return serializeApprovalRequest(await this.first(`SELECT * FROM approval_requests WHERE id = ? LIMIT 1`, [id]));
}
