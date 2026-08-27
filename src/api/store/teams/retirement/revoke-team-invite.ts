import { isoNow,ControlPlaneStore } from "../../../persistence/store.ts";
export async function revokeTeamInviteMethod(this: ControlPlaneStore, teamId, inviteId, expectedUpdatedAt?) {
    await this.ensureInitialized();
    const result = await this.run(`UPDATE team_invites SET status = 'revoked', updated_at = ? WHERE id = ? AND team_id = ? AND status = 'pending'${expectedUpdatedAt ? ' AND updated_at = ?' : ''}`, [isoNow(), inviteId, teamId, ...(expectedUpdatedAt ? [expectedUpdatedAt] : [])]);
    const changes = Number(result?.meta?.changes ?? result?.changes ?? 0);
    if (changes !== 1) {
        const existing = await this.getTeamInvite(inviteId);
        return existing ? { ok: false, code: 'stale', message: 'The invitation changed. Reload and try again.' } : { ok: false, code: 'missing', message: 'The invitation was not found.' };
    }
    return { ok: true };
}
