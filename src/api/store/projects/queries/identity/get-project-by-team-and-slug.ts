import { ControlPlaneStore,serializeProject } from "../../../../persistence/store.ts";
export async function getProjectByTeamAndSlugMethod(this: ControlPlaneStore, teamId, slug) {
    await this.ensureInitialized();
    return serializeProject(await this.first(`SELECT * FROM projects WHERE team_id = ? AND slug = ? LIMIT 1`, [teamId, slug]));
}
