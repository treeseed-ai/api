import { isoNow,ControlPlaneStore } from "../../../../persistence/store.ts";
export async function upsertProjectSummarySnapshotMethod(this: ControlPlaneStore, projectId, teamId, summary) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    await this.run(`INSERT OR REPLACE INTO project_summary_snapshots (
				project_id, team_id, summary_json, generated_at, created_at, updated_at
			) VALUES (
				?, ?, ?, ?,
				COALESCE((SELECT created_at FROM project_summary_snapshots WHERE project_id = ?), ?),
				?
			)`, [
        projectId,
        teamId,
        JSON.stringify(summary ?? {}),
        timestamp,
        projectId,
        timestamp,
        timestamp,
    ]);
    return this.getProjectSummarySnapshot(projectId);
}
