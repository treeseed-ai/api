import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { accountDeletionConfirmationMatches } from '../../../auth/account.ts';
import { sendAuthEmail } from '../../../auth/email.ts';
import { deleteTeamCapacityAggregate } from '../../capacity/services/teams/team-deletion-service.ts';
import {
	accountDeletionBlockers,
	consumeReauthentication,
	hashControlPlanePassword,
	normalizeEmail,
	normalizeUsername,
	passwordResetUrlFor,
	validateControlPlanePassword,
} from '../../app/support/index.ts';

type ServiceResult = { ok: true; [key: string]: unknown } | { ok: false; status: number; code: string; message: string; details?: unknown };
const fail = (status: number, code: string, message: string, details?: unknown): ServiceResult => ({ ok: false, status, code, message, details });

export function createAccountSecurityService(store: any, emailContext: any) {
	return {
		async updatePassword(user: Record<string, any>, input: Record<string, unknown>): Promise<ServiceResult> {
			await store.ensureInitialized();
			const password = String(input.password ?? input.newPassword ?? '');
			if (!validateControlPlanePassword(password)) return fail(400, 'invalid_password', 'Password must be at least 12 characters.');
			if (!await consumeReauthentication(store, user, 'password_change', input)) {
				return fail(401, 'reauthentication_required', 'Current credentials were not accepted.');
			}
			const existing = await store.first('SELECT password_hash FROM control_plane_auth_credentials WHERE user_id = ? LIMIT 1', [user.id]);
			const now = new Date().toISOString();
			if (existing) {
				await store.run('UPDATE control_plane_auth_credentials SET password_hash = ?, updated_at = ? WHERE user_id = ?',
					[hashControlPlanePassword(password), now, user.id]);
			} else {
				const email = normalizeEmail(user.metadata?.email) || `${user.id}@treeseed.local`;
				const username = normalizeUsername(user.metadata?.username ?? user.id) || null;
				await store.run(`INSERT INTO control_plane_auth_credentials
					(user_id, email, username, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
					[user.id, email, username, hashControlPlanePassword(password), now, now]);
			}
			await store.recordAuditEvent({ actorType: 'user', actorId: user.id, eventType: 'auth.password.changed', targetType: 'user', targetId: user.id });
			return { ok: true, changed: true };
		},

		async requestPasswordReset(emailValue: unknown): Promise<ServiceResult> {
			await store.ensureInitialized();
			const email = normalizeEmail(emailValue);
			const credential = email ? await store.first(`SELECT control_plane_auth_credentials.user_id
				FROM control_plane_auth_credentials INNER JOIN user_email_addresses
				ON user_email_addresses.user_id = control_plane_auth_credentials.user_id
				AND user_email_addresses.normalized_email = ? AND user_email_addresses.status = 'verified'
				WHERE control_plane_auth_credentials.status = 'active' LIMIT 1`, [email]) : null;
			if (!credential) return { ok: true, sent: true };
			const token = `reset_${randomBytes(24).toString('base64url')}`;
			const now = new Date().toISOString();
			await store.run(`INSERT INTO control_plane_auth_password_resets (id, user_id, token_hash, expires_at, used_at, created_at)
				VALUES (?, ?, ?, ?, NULL, ?)`, [randomUUID(), credential.user_id, digest(token), new Date(Date.now() + 3_600_000).toISOString(), now]);
			try {
				const resetUrl = passwordResetUrlFor(emailContext, token);
				await sendAuthEmail(emailContext, { to: email, subject: 'Reset your TreeSeed password',
					text: `Reset your TreeSeed password:\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
					html: `<p>Reset your TreeSeed password:</p><p><a href="${resetUrl}">Reset password</a></p>` });
				return { ok: true, sent: true };
			} catch {
				return fail(503, 'password_reset_delivery_failed', 'Password reset email could not be sent. Try again shortly.');
			}
		},

		async completePasswordReset(input: Record<string, unknown>): Promise<ServiceResult> {
			await store.ensureInitialized();
			const token = String(input.token ?? '');
			const password = String(input.password ?? input.newPassword ?? '');
			if (!token || !validateControlPlanePassword(password)) return fail(400, 'invalid_password_reset', 'A valid reset token and password are required.');
			const now = new Date().toISOString();
			const row = await store.first(`UPDATE control_plane_auth_password_resets SET used_at = ?
				WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING id, user_id`, [now, digest(token), now]);
			if (!row) return fail(401, 'invalid_password_reset', 'Password reset token is invalid or expired.');
			await store.run('UPDATE control_plane_auth_credentials SET password_hash = ?, updated_at = ? WHERE user_id = ?', [hashControlPlanePassword(password), now, row.user_id]);
			await store.recordAuditEvent({ actorType: 'user', actorId: row.user_id, eventType: 'auth.password.reset', targetType: 'user', targetId: row.user_id });
			return { ok: true, changed: true };
		},

		async deletionBlockers(user: Record<string, any>) {
			const [blockers, account] = await Promise.all([
				accountDeletionBlockers(store, user),
				store.first('SELECT updated_at FROM users WHERE id = ? LIMIT 1', [user.id]),
			]);
			return { blockers, canDelete: blockers.length === 0, updatedAt: String(account?.updated_at ?? '0') };
		},

		async removeAccount(user: Record<string, any>, input: Record<string, unknown>): Promise<ServiceResult> {
			await store.ensureInitialized();
			if (!accountDeletionConfirmationMatches(String(input.confirmation ?? ''))) return fail(409, 'confirmation_required', 'Type "DELETE MY ACCOUNT" to delete this account.');
			const blockers = await accountDeletionBlockers(store, user);
			if (blockers.length) return fail(409, 'deletion_blocked', 'Account deletion is blocked.', { blockers });
			if (!await consumeReauthentication(store, user, 'account_delete', input)) return fail(401, 'reauthentication_required', 'Current credentials were not accepted.');
			const personalTeams = (await store.listTeamsForPrincipal(user)).filter((team: any) => team.metadata?.kind === 'personal_research' && team.metadata?.ownerUserId === user.id);
			for (const team of personalTeams) {
				const deleted = await deleteTeamCapacityAggregate(store, team.id, `DELETE ${team.name ?? team.slug}`);
				if (!deleted.ok) return fail(409, 'personal_team_deletion_failed', 'Personal account workspace could not be deleted.');
			}
			const now = new Date().toISOString();
			await store.batch(accountDeletionStatements(user.id, now));
			await store.recordAuditEvent({ actorType: 'user', actorId: user.id, eventType: 'account.deleted', targetType: 'user', targetId: user.id });
			return { ok: true, deleted: true };
		},
	};
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function accountDeletionStatements(userId: string, now: string) {
	const tables = ['user_email_addresses', 'user_identities', 'auth_reauthentication_grants', 'user_personal_themes', 'user_preferences',
		'user_notification_global_content_types', 'user_notification_project_content_types', 'user_notification_project_overrides',
		'user_notification_preferences', 'notification_email_deliveries', 'user_notifications'];
	return [
		{ query: "UPDATE users SET status = 'deleted', updated_at = ? WHERE id = ?", params: [now, userId] },
		{ query: "UPDATE control_plane_auth_credentials SET email = ?, status = 'deleted', updated_at = ? WHERE user_id = ?", params: [`deleted+${userId}@invalid`, now, userId] },
		...tables.map((table) => ({ query: `DELETE FROM ${table} WHERE user_id = ?`, params: [userId] })),
		{ query: 'UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE user_id = ?', params: [now, now, userId] },
	];
}
