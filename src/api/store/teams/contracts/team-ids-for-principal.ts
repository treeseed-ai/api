import { ControlPlaneStore } from "../../../persistence/store.ts";
export async function teamIdsForPrincipalMethod(this: ControlPlaneStore, principal) {
    await this.ensureInitialized();
    if (!principal)
        return [];
    const directTeamId = principal.metadata?.teamId;
    if (typeof directTeamId === 'string' && directTeamId) {
        return [directTeamId];
    }
    const userId = typeof principal.id === 'string' ? principal.id : '';
    if (!userId)
        return [];
    const memberships = await this.all(`SELECT team_id
			 FROM team_memberships
			 WHERE user_id = ? AND status = 'active'
			 ORDER BY created_at ASC`, [userId]);
    return memberships.map((row) => row.team_id);
}
