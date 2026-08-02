import { MarketControlPlaneStore,serializeProject } from "../../../../persistence/store.ts";
export async function listTeamProjectsMethod(this: MarketControlPlaneStore, teamId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM projects WHERE team_id = ? ORDER BY created_at ASC`, [teamId]);
    return rows.map(serializeProject).filter((project) => project?.metadata?.deletion?.status !== 'succeeded');
}
