import { equalHash,isoNow,MarketControlPlaneStore,serializeTeamInvite,stableHash,tokenPrefix } from "../../../persistence/store.ts";
export async function acceptTeamInviteMethod(this: MarketControlPlaneStore, token, userId) {
    await this.ensureInitialized();
    const prefix = tokenPrefix(String(token ?? ''));
    const rows = await this.all(`SELECT * FROM team_invites WHERE token_prefix = ? ORDER BY created_at DESC`, [prefix]);
    for (const row of rows) {
        if (!equalHash(stableHash(token, String(this.config.authSecret ?? '')), String(row.token_hash ?? '')))
            continue;
        if (row.status === 'accepted' && row.accepted_by_user_id === userId) {
            const member = await this.first(`SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active' LIMIT 1`, [row.team_id, userId]);
            return { ok: true, invite: serializeTeamInvite(row), member, team: await this.getTeam(row.team_id), alreadyAccepted: true };
        }
        if (row.status !== 'pending')
            continue;
        if (row.expires_at && new Date(String(row.expires_at)).getTime() <= Date.now()) {
            await this.run(`UPDATE team_invites SET status = 'expired', updated_at = ? WHERE id = ?`, [isoNow(), row.id]);
            continue;
        }
        const email = await this.first(`SELECT normalized_email FROM user_email_addresses WHERE user_id = ? AND normalized_email = ? AND status = 'verified' LIMIT 1`, [userId, row.email]);
        if (!email?.normalized_email) {
            return { ok: false, code: 'email_mismatch', message: `Sign in with ${row.email} to accept this invite.` };
        }
        const member = await this.upsertTeamMember(String(row.team_id), userId, String(row.role_key));
        await this.run(`UPDATE team_invites
				 SET status = 'accepted', accepted_by_user_id = ?, accepted_at = ?, updated_at = ?
				 WHERE id = ?`, [userId, isoNow(), isoNow(), row.id]);
        return { ok: true, invite: serializeTeamInvite(row), member, team: await this.getTeam(row.team_id) };
    }
    return { ok: false, code: 'invalid', message: 'Invite link is invalid or expired.' };
}
