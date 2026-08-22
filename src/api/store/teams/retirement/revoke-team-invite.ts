import { isoNow,ControlPlaneStore } from "../../../persistence/store.ts";
export async function revokeTeamInviteMethod(this: ControlPlaneStore, teamId, inviteId) {
    await this.ensureInitialized();
    await this.run(`UPDATE team_invites SET status = 'revoked', updated_at = ? WHERE id = ? AND team_id = ? AND status = 'pending'`, [isoNow(), inviteId, teamId]);
    return { ok: true };
}
