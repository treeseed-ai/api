import { MarketControlPlaneStore,serializeProject } from "../../../../persistence/store.ts";
export async function listProjectsForPrincipalMethod(this: MarketControlPlaneStore, principal) {
    await this.ensureInitialized();
    const teamIds = await this.teamIdsForPrincipal(principal);
    if (teamIds.length === 0) {
        return [];
    }
    const placeholders = teamIds.map(() => '?').join(', ');
    const rows = await this.all(`SELECT * FROM projects WHERE team_id IN (${placeholders}) ORDER BY created_at ASC`, teamIds);
    return rows.map(serializeProject).filter((project) => project?.metadata?.deletion?.status !== 'succeeded');
}
