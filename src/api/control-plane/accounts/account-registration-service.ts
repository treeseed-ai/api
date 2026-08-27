import { randomUUID } from 'node:crypto';
import {
	CONTROL_PLANE_EMAIL_CONFIRMATION_PREFIX,
	authTokenTimestampMillis,
	controlPlaneEmailTokenHash,
	createControlPlaneEmailConfirmation,
	hashControlPlanePassword,
	normalizeAppearancePreference,
	normalizeEmail,
	normalizeUsername,
	optionalTrimmedString,
	setPrimaryEmailAddress,
	validateControlPlanePassword,
	verifiedEmailCount,
} from '../../app/support/index.ts';
import { validateUsername as validatePublicUsername } from '../../../auth/profile-validation.ts';

type ServiceResult = { ok: true; [key: string]: unknown } | {
	ok: false;
	status: number;
	code: string;
	message: string;
};

export function createAccountRegistrationService(store: any, authProvider: any, emailContext: any) {
	return {
		async register(input: Record<string, unknown>): Promise<ServiceResult> {
			await store.ensureInitialized();
			const email = normalizeEmail(input.email);
			const username = normalizeUsername(input.username);
			const password = String(input.password ?? '');
			const displayName = String(input.displayName ?? input.name ?? email).trim();
			const inviteToken = String(input.inviteToken ?? '').trim();
			const usernameValidation = validatePublicUsername(username);
			if (!email || !email.includes('@')) return failure(400, 'invalid_email', 'A valid email is required.');
			if (!usernameValidation.ok) return failure(400, 'invalid_username', usernameValidation.message);
			if (!validateControlPlanePassword(password)) return failure(400, 'invalid_password', 'Password must be at least 12 characters.');
			const invite = inviteToken ? await store.getPendingTeamInviteByToken(inviteToken) : null;
			if (inviteToken && (!invite?.ok || normalizeEmail(invite.invite?.email) !== email)) {
				return failure(400, 'invite_email_mismatch', 'Team invite does not match this registration email.');
			}
			if (await identityUnavailable(store, email, username)) {
				return failure(409, 'identity_unavailable', 'This email or username cannot be used.');
			}
			const synced = await authProvider.syncUserIdentity({ provider: 'credential', providerSubject: email,
				email, emailVerified: false, username, displayName, profile: {
					firstName: optionalTrimmedString(input.firstName), lastName: optionalTrimmedString(input.lastName),
				} });
			const now = new Date().toISOString();
			const appearance = normalizeAppearancePreference(input.appearance && typeof input.appearance === 'object' ? input.appearance : input);
			await store.run('UPDATE users SET metadata_json = ?, updated_at = ? WHERE id = ?',
				[JSON.stringify({ ...(synced.principal.metadata ?? {}), appearance }), now, synced.principal.id]);
			await store.run(`INSERT INTO control_plane_auth_credentials (user_id, email, username, password_hash, status, created_at, updated_at)
				VALUES (?, ?, ?, ?, 'pending_email_confirmation', ?, ?)`,
				[synced.principal.id, email, username, hashControlPlanePassword(password), now, now]);
			const emailAddressId = randomUUID();
			await store.run(`INSERT INTO user_email_addresses
				(id, user_id, email, normalized_email, status, is_primary, verification_requested_at, verified_at, created_at, updated_at)
				VALUES (?, ?, ?, ?, 'pending', 1, NULL, NULL, ?, ?)`, [emailAddressId, synced.principal.id, email, email, now, now]);
			try {
				const confirmation = await createControlPlaneEmailConfirmation(store, emailContext, {
					email, emailAddressId, displayName, returnTo: String(input.returnTo ?? '/app/'),
				});
				await store.recordAuditEvent({ actorType: 'system', actorId: null, eventType: 'auth.user.registered',
					targetType: 'user', targetId: synced.principal.id });
				return { ok: true, confirmationRequired: true, email, expiresInSeconds: confirmation.expiresInSeconds };
			} catch {
				await rollbackRegistration(store, synced.principal.id, emailAddressId);
				return failure(503, 'email_confirmation_delivery_failed', 'Email confirmation could not be sent. Try again shortly.');
			}
		},

		async confirm(tokenValue: unknown): Promise<ServiceResult> {
			await store.ensureInitialized();
			const token = String(tokenValue ?? '').trim();
			if (!token) return failure(400, 'confirmation_token_required', 'Email confirmation token is required.');
			const row = await store.first('SELECT * FROM better_auth_verification WHERE value = ? AND identifier LIKE ? LIMIT 1',
				[controlPlaneEmailTokenHash(token), `${CONTROL_PLANE_EMAIL_CONFIRMATION_PREFIX}%`]);
			const expiresAt = authTokenTimestampMillis(row?.expiresAt ?? row?.expiresat ?? 0);
			if (!row || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return invalidConfirmation();
			const emailAddressId = String(row.identifier ?? '').slice(CONTROL_PLANE_EMAIL_CONFIRMATION_PREFIX.length);
			const address = await store.first('SELECT * FROM user_email_addresses WHERE id = ? LIMIT 1', [emailAddressId]);
			const credential = address?.id ? await store.first(
				'SELECT user_id, username, status FROM control_plane_auth_credentials WHERE user_id = ? LIMIT 1', [address.user_id]) : null;
			if (!address?.id || !credential || credential.status === 'deleted') return invalidConfirmation();
			const now = new Date().toISOString();
			const firstVerified = (await verifiedEmailCount(store, address.user_id)) === 0;
			if (firstVerified) {
				const personalTeam = await store.ensurePersonalResearchTeamForUser(address.user_id);
				if (!personalTeam.ok) return failure(personalTeam.code === 'namespace_conflict' ? 409 : 400,
					String(personalTeam.code ?? 'personal_team_failed'), personalTeam.message);
			}
			await store.run("UPDATE user_email_addresses SET status = 'verified', verified_at = COALESCE(verified_at, ?), updated_at = ? WHERE id = ?",
				[now, now, address.id]);
			await store.claimSeedTeamMembershipsForVerifiedEmail(address.user_id, normalizeEmail(address.email));
			if (Number(address.is_primary ?? 0) === 1 || firstVerified) await setPrimaryEmailAddress(store, address.user_id, address.id);
			await store.run("UPDATE control_plane_auth_credentials SET status = 'active', updated_at = ? WHERE user_id = ?", [now, address.user_id]);
			await store.run("UPDATE user_identities SET email_verified = 1, updated_at = ? WHERE user_id = ? AND provider = 'credential'", [now, address.user_id]).catch(() => null);
			await store.run('DELETE FROM better_auth_verification WHERE id = ?', [row.id]).catch(() => null);
			await store.recordAuditEvent({ actorType: 'user', actorId: address.user_id, eventType: 'auth.email.verified',
				targetType: 'user', targetId: address.user_id, data: { emailAddressId: address.id } });
			return { ok: true, confirmed: true };
		},
	};
}

function failure(status: number, code: string, message: string): ServiceResult {
	return { ok: false, status, code, message };
}

function invalidConfirmation(): ServiceResult {
	return failure(401, 'invalid_confirmation_token', 'Email confirmation token is invalid or expired.');
}

async function identityUnavailable(store: any, email: string, username: string) {
	const [emailCredential, usernameCredential, emailAddress, publicUser, publicTeam] = await Promise.all([
		store.first('SELECT user_id FROM control_plane_auth_credentials WHERE email = ? LIMIT 1', [email]),
		store.first('SELECT user_id FROM control_plane_auth_credentials WHERE username = ? LIMIT 1', [username]),
		store.first('SELECT user_id FROM user_email_addresses WHERE normalized_email = ? LIMIT 1', [email]),
		store.publicUsernameExists(username), store.teamPublicNameExists(username),
	]);
	return Boolean(emailCredential || usernameCredential || emailAddress || publicUser || publicTeam);
}

async function rollbackRegistration(store: any, userId: string, emailAddressId: string) {
	await store.run('DELETE FROM control_plane_auth_credentials WHERE user_id = ?', [userId]).catch(() => null);
	await store.run('DELETE FROM user_email_addresses WHERE user_id = ?', [userId]).catch(() => null);
	await store.run('DELETE FROM better_auth_verification WHERE identifier = ?',
		[`${CONTROL_PLANE_EMAIL_CONFIRMATION_PREFIX}${emailAddressId}`]).catch(() => null);
}
