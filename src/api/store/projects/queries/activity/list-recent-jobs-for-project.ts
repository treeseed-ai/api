import { ControlPlaneStore,serializeJob } from "../../../../persistence/store.ts";
export async function listRecentJobsForProjectMethod(this: ControlPlaneStore, projectId, limit = 10) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM remote_jobs WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT ?`, [projectId, Math.max(1, Math.min(Number(limit) || 10, 50))]);
    return rows.map(serializeJob);
}
