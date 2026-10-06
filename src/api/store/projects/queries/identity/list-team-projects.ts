import { ControlPlaneStore,serializeProject, type ProjectRow } from "../../../../persistence/store.ts";
export async function listTeamProjectsMethod(this: Pick<ControlPlaneStore, 'ensureInitialized' | 'all'>, teamId: string) {
    await this.ensureInitialized();
    const rows = await this.all<ProjectRow>(`SELECT * FROM projects WHERE team_id = ? ORDER BY created_at ASC`, [teamId]);
    return rows.map(serializeProject).filter((project): project is NonNullable<typeof project> => project !== null && project.metadata?.deletion?.status !== 'succeeded');
}
