import { ControlPlaneStore,serializeProjectSummarySnapshot } from "../../../../persistence/store.ts";
export async function getProjectSummarySnapshotMethod(this: ControlPlaneStore, projectId) {
    await this.ensureInitialized();
    return serializeProjectSummarySnapshot(await this.first(`SELECT * FROM project_summary_snapshots WHERE project_id = ? LIMIT 1`, [projectId]));
}
