import { equalHash,isoNow,ControlPlaneStore,serializeTeamInvite,stableHash,tokenPrefix } from "../../../../persistence/store.ts";
export async function getTeamInviteByTokenMethod(this: ControlPlaneStore, token) {
    await this.ensureInitialized();
    const prefix = tokenPrefix(String(token ?? ''));
    const rows = await this.all(`SELECT * FROM team_invites WHERE token_prefix = ? ORDER BY created_at DESC`, [prefix]);
    for (const row of rows) {
        if (!equalHash(stableHash(token, String(this.config.authSecret ?? '')), String(row.token_hash ?? '')))
            continue;
        if (row.status === 'pending' && row.expires_at && new Date(String(row.expires_at)).getTime() <= Date.now()) {
            await this.run(`UPDATE team_invites SET status = 'expired', updated_at = ? WHERE id = ?`, [isoNow(), row.id]);
            row.status = 'expired';
            row.updated_at = isoNow();
        }
        const team = await this.getTeam(row.team_id);
        return { ok: true, invite: serializeTeamInvite(row), team };
    }
    return { ok: false, code: 'invalid', message: 'Invite link is invalid or expired.' };
}
