import { MarketControlPlaneStore,serializeApprovalRequest } from "../../../../persistence/store.ts";
export async function listApprovalRequestsForProjectMethod(this: MarketControlPlaneStore, projectId, limit = 50) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM approval_requests
			 WHERE project_id = ?
			 ORDER BY created_at DESC LIMIT ?`, [projectId, Math.max(1, Math.min(200, Number(limit) || 50))]);
    return rows.map(serializeApprovalRequest);
}
