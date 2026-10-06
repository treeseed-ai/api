import { ControlPlaneStore,serializeProject, type ProjectRow } from "../../../../persistence/store.ts";
export async function getProjectByTeamAndSlugMethod(this: ControlPlaneStore, teamId: string, slug: string) {
    await this.ensureInitialized();
    return serializeProject(await this.first<ProjectRow>(`SELECT * FROM projects WHERE team_id = ? AND slug = ? LIMIT 1`, [teamId, slug]));
}
