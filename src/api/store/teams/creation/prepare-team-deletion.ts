import { ControlPlaneStore,teamDeletionConfirmationMatches } from "../../../persistence/store.ts";
export async function prepareTeamDeletionMethod(this: ControlPlaneStore, teamId, confirmation) {
    await this.ensureInitialized();
    const team = await this.getTeam(teamId);
    if (!team)
        return { ok: false, code: 'missing', message: 'Team not found.' };
    if (!teamDeletionConfirmationMatches(confirmation, team.name)) {
        return { ok: false, code: 'confirmation', message: `Type DELETE ${team.name} to confirm.` };
    }
    const blockers = await this.evaluateTeamDeletionBlockers(teamId);
    if (blockers.length > 0) {
        return { ok: false, code: 'blocked', message: 'Team still has owned content.', blockers };
    }
    return { ok: true, team };
}
