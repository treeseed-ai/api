import { randomUUID } from 'node:crypto';
import type { MarketControlPlaneStore } from '../../../persistence/store.ts';
import { isoNow,serializeTeamInvite,stableHash,tokenPrefix } from '../../support/index.ts';

export async function resendTeamInviteMethod(this: MarketControlPlaneStore, teamId: string, inviteId: string) {
	await this.ensureInitialized();
	const invite = await this.first(`SELECT * FROM team_invites WHERE id = ? AND team_id = ? LIMIT 1`, [inviteId, teamId]);
	if (!invite?.id) return { ok: false, code: 'missing', message: 'Invitation not found.' };
	if (invite.status !== 'pending') return { ok: false, code: 'not_pending', message: 'Only pending invitations can be resent.' };
	const token = `tiv_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
	const timestamp = isoNow();
	const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
	await this.run(`UPDATE team_invites
		SET token_prefix = ?, token_hash = ?, expires_at = ?, updated_at = ?
		WHERE id = ? AND team_id = ? AND status = 'pending'`, [
		tokenPrefix(token),
		stableHash(token, String(this.config.authSecret ?? '')),
		expiresAt,
		timestamp,
		inviteId,
		teamId,
	]);
	return { ok: true, invite: serializeTeamInvite({ ...invite, expires_at: expiresAt, updated_at: timestamp }), token };
}
