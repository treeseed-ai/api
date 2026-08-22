import { equalHash,isoNow,ControlPlaneStore,serializeTeamInvite,stableHash,tokenPrefix } from "../../../../persistence/store.ts";
export async function getPendingTeamInviteByTokenMethod(this: ControlPlaneStore, token) {
    await this.ensureInitialized();
    const prefix = tokenPrefix(String(token ?? ''));
    const rows = await this.all(`SELECT * FROM team_invites WHERE token_prefix = ? AND status = 'pending'`, [prefix]);
    for (const row of rows) {
        if (row.expires_at && new Date(String(row.expires_at)).getTime() <= Date.now()) {
            await this.run(`UPDATE team_invites SET status = 'expired', updated_at = ? WHERE id = ?`, [isoNow(), row.id]);
            continue;
        }
        if (!equalHash(stableHash(token, String(this.config.authSecret ?? '')), String(row.token_hash ?? '')))
            continue;
        const team = await this.getTeam(row.team_id);
        return { ok: true, invite: serializeTeamInvite(row), team };
    }
    return { ok: false, code: 'invalid', message: 'Invite link is invalid or expired.' };
}
