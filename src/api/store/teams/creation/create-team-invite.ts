import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,normalizeTeamRoleKey,serializeTeamInvite,stableHash,tokenPrefix } from "../../../persistence/store.ts";
export async function createTeamInviteMethod(this: ControlPlaneStore, teamId, input) {
    await this.ensureInitialized();
    const email = String(input.email ?? '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
        return { ok: false, code: 'invalid_email', message: 'A valid invite email is required.' };
    }
    const roleKey = normalizeTeamRoleKey(input.roleKey);
    const token = `tiv_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
    const timestamp = isoNow();
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const existing = await this.first(`SELECT * FROM team_invites
        WHERE team_id = ? AND email = ? AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`, [teamId, email]);
    if (existing?.id) {
        if (new Date(String(existing.expires_at)).getTime() > Date.now()) {
            return {
                ok: false,
                code: 'invite_already_pending',
                message: 'A pending invitation already exists for this email.',
                invite: serializeTeamInvite(existing),
            };
        }
        await this.run(`UPDATE team_invites SET status = 'expired', updated_at = ? WHERE id = ?`, [timestamp, existing.id]);
    }
    const id = randomUUID();
    await this.run(`INSERT INTO team_invites (
				id, team_id, email, role_key, token_prefix, token_hash, status, invited_by_user_id, expires_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`, [
        id,
        teamId,
        email,
        roleKey,
        tokenPrefix(token),
        stableHash(token, String(this.config.authSecret)),
        typeof input.invitedByUserId === 'string' ? input.invitedByUserId : null,
        expiresAt,
        timestamp,
        timestamp,
    ]);
    return { ok: true, invite: await this.getTeamInvite(id), token };
}
