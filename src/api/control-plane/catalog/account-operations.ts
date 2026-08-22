import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { ControlPlaneOperationError, type BoundOperation } from './operation-registry.ts';

export interface AccountOperationDependencies {
	store: {
		listTeamsForPrincipal(principal: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
		listProjectsForPrincipal(principal: Record<string, unknown>): Promise<Array<Record<string, any>>>;
		first(query: string, parameters?: unknown[]): Promise<Record<string, any> | null>;
		all(query: string, parameters?: unknown[]): Promise<Array<Record<string, any>>>;
		run(query: string, parameters?: unknown[]): Promise<unknown>;
		recordAuditEvent(event: Record<string, unknown>): Promise<unknown>;
	};
	listUserEmailAddresses(userId: string): Promise<Array<Record<string, unknown>>>;
	accountEmails: {
		add(user: Record<string, any>, email: unknown): Promise<Record<string, any>>;
		verify(user: Record<string, any>, emailId: string): Promise<Record<string, any>>;
		makePrimary(user: Record<string, any>, emailId: string): Promise<Record<string, any>>;
		remove(user: Record<string, any>, emailId: string): Promise<Record<string, any>>;
	};
	accountRegistration: {
		register(input: Record<string, unknown>): Promise<Record<string, any>>;
		confirm(token: unknown): Promise<Record<string, any>>;
	};
}

function serviceResult(result: Record<string, any>, fallback: string) {
	if (!result.ok) throw new ControlPlaneOperationError(Number(result.status ?? 400), String(result.code ?? 'account_operation_failed'), String(result.message ?? fallback));
	return result;
}

export function createAccountRegisterOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.register> {
	return { binding: CONTROL_PLANE_OPERATIONS.accounts.register, async handler(input) {
		return serviceResult(await dependencies.accountRegistration.register(input.body as Record<string, unknown>), 'Registration failed.');
	} };
}

export function createAccountEmailConfirmOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.confirmEmail> {
	return { binding: CONTROL_PLANE_OPERATIONS.accounts.confirmEmail, async handler(input) {
		return serviceResult(await dependencies.accountRegistration.confirm((input.body as Record<string, unknown>).token), 'Email confirmation failed.');
	} };
}

function principal(context: { principal?: Record<string, any> }) {
	if (!context.principal) throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
	return context.principal;
}

function jsonObject(value: unknown): Record<string, any> {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
	if (typeof value !== 'string') return {};
	try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

export function createCurrentAccountOperation(
	dependencies: AccountOperationDependencies,
): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.current> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.accounts.current,
		async handler(_input, context) {
			if (!context.principal) {
				throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
			}
			return {
				principal: context.principal,
				teams: await dependencies.store.listTeamsForPrincipal(context.principal),
			};
		},
	};
}

export function createAccountIdentityOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.identity> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.accounts.identity,
		async handler(_input, context) {
			const actor = principal(context);
			const [user, credential, identities, emails] = await Promise.all([
				dependencies.store.first('SELECT id, username, display_name, metadata_json FROM users WHERE id = ? LIMIT 1', [actor.id]),
				dependencies.store.first("SELECT user_id FROM control_plane_auth_credentials WHERE user_id = ? AND status = 'active' LIMIT 1", [actor.id]),
				dependencies.store.all("SELECT id, provider, email, created_at FROM user_identities WHERE user_id = ? AND provider <> 'credential' ORDER BY created_at", [actor.id]),
				dependencies.listUserEmailAddresses(actor.id),
			]);
			const metadata = jsonObject(user?.metadata_json);
			const methods = identities.length + (credential ? 1 : 0);
			return { id: actor.id, username: user?.username ?? metadata.username ?? null,
				displayName: user?.display_name ?? actor.displayName ?? '', firstName: metadata.firstName ?? null,
				lastName: metadata.lastName ?? null, image: metadata.image ?? null, headline: metadata.headline ?? null,
				profileSummary: metadata.profileSummary ?? null, location: metadata.location ?? null, website: metadata.website ?? null,
				expertise: Array.isArray(metadata.expertise) ? metadata.expertise : [], hasCredential: Boolean(credential), emails,
				providers: identities.map((identity) => ({ id: identity.id, provider: identity.provider, email: identity.email,
					linkedAt: identity.created_at, canUnlink: methods > 1 })) };
		},
	};
}

export function createAccountEmailsOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.emails> {
	return { binding: CONTROL_PLANE_OPERATIONS.accounts.emails,
		async handler(_input, context) { return { items: await dependencies.listUserEmailAddresses(principal(context).id) }; } };
}

function emailFailure(result: Record<string, any>, fallback: string): never {
	throw new ControlPlaneOperationError(Number(result.status ?? 400), String(result.code ?? 'email_operation_failed'), String(result.message ?? result.error ?? fallback));
}

export function createAccountEmailAddOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.addEmail> {
	return { binding: CONTROL_PLANE_OPERATIONS.accounts.addEmail, async handler(input, context) {
		try {
			const result = await dependencies.accountEmails.add(principal(context), (input.body as Record<string, unknown>).email);
			if (!result.ok) emailFailure(result, 'The email address could not be added.');
			return result;
		} catch (error) {
			if (error instanceof ControlPlaneOperationError) throw error;
			throw new ControlPlaneOperationError(503, 'email_verification_delivery_failed', 'Email verification could not be delivered. Try again shortly.');
		}
	} };
}

export function createAccountEmailVerifyOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.verifyEmail> {
	return { binding: CONTROL_PLANE_OPERATIONS.accounts.verifyEmail, async handler(input, context) {
		try {
			const result = await dependencies.accountEmails.verify(principal(context), input.path.emailId);
			if (!result.ok) emailFailure(result, 'Email verification could not be requested.');
			return result;
		} catch (error) {
			if (error instanceof ControlPlaneOperationError) throw error;
			throw new ControlPlaneOperationError(503, 'email_verification_delivery_failed', 'Email verification could not be delivered. Try again shortly.');
		}
	} };
}

export function createAccountEmailPrimaryOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.makePrimaryEmail> {
	return { binding: CONTROL_PLANE_OPERATIONS.accounts.makePrimaryEmail, async handler(input, context) {
		const result = await dependencies.accountEmails.makePrimary(principal(context), input.path.emailId);
		if (!result.ok) emailFailure(result, 'The primary email could not be changed.');
		return { emailAddress: result.emailAddress };
	} };
}

export function createAccountEmailRemoveOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.removeEmail> {
	return { binding: CONTROL_PLANE_OPERATIONS.accounts.removeEmail, async handler(input, context) {
		const result = await dependencies.accountEmails.remove(principal(context), input.path.emailId);
		if (!result.ok) emailFailure(result, 'The email address could not be removed.');
		return { items: result.items };
	} };
}

export function createAccountSessionsOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.sessions> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.accounts.sessions,
		async handler(_input, context) {
			const actor = principal(context);
			const sessions = await dependencies.store.all(`SELECT id, session_type, expires_at, revoked_at, data_json, created_at, updated_at
				FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [actor.id]);
			return { items: sessions.map((session) => { const data = jsonObject(session.data_json); return {
				id: session.id, provider: session.session_type, expiresAt: session.expires_at, revokedAt: session.revoked_at,
				authenticatedAt: session.created_at, lastSeenAt: session.updated_at,
				ipAddress: typeof data.ipAddress === 'string' ? data.ipAddress : null,
				userAgent: typeof data.userAgent === 'string' ? data.userAgent : null,
				current: actor.metadata?.sessionId === session.id,
			}; }) };
		},
	};
}

export function createAccountSessionRevokeOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.revokeSession> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.accounts.revokeSession,
		async handler(input, context) {
			const actor = principal(context);
			if (actor.metadata?.sessionId === input.path.sessionId) throw new ControlPlaneOperationError(409, 'current_session', 'Use sign out to end the current session.');
			const existing = await dependencies.store.first('SELECT revoked_at FROM auth_sessions WHERE id = ? AND user_id = ? LIMIT 1', [input.path.sessionId, actor.id]);
			if (!existing) return { id: input.path.sessionId, status: 'not-found' };
			const now = new Date().toISOString();
			await dependencies.store.run('UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ? AND user_id = ?',
				[now, now, input.path.sessionId, actor.id]);
			await dependencies.store.recordAuditEvent({ actorType: 'user', actorId: actor.id, eventType: 'auth.session.revoked', targetType: 'auth_session', targetId: input.path.sessionId });
			return { id: input.path.sessionId, status: existing.revoked_at ? 'already-revoked' : 'revoked' };
		},
	};
}

function optionalString(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function createAccountProfileUpdateOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.updateProfile> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.accounts.updateProfile,
		async handler(input, context) {
			const actor = principal(context);
			const body = input.body as Record<string, unknown>;
			const firstName = optionalString(body.firstName), lastName = optionalString(body.lastName);
			const displayName = String(body.displayName ?? body.name ?? [firstName, lastName].filter(Boolean).join(' ')).trim();
			const headline = optionalString(body.headline), profileSummary = optionalString(body.profileSummary), website = optionalString(body.website);
			if (!displayName) throw new ControlPlaneOperationError(400, 'profile_name_required', 'Display name is required.');
			if (headline && headline.length > 120) throw new ControlPlaneOperationError(400, 'profile_headline_invalid', 'Headline must be 120 characters or fewer.');
			if (profileSummary && profileSummary.length > 600) throw new ControlPlaneOperationError(400, 'profile_summary_invalid', 'Profile summary must be 600 characters or fewer.');
			if (website && (!website.startsWith('https://') || website.length > 240)) throw new ControlPlaneOperationError(400, 'profile_website_invalid', 'Website must be a valid HTTPS URL.');
			const expertise = (Array.isArray(body.expertise) ? body.expertise : String(body.expertise ?? '').split(','))
				.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 8);
			const metadata = { ...(actor.metadata ?? {}), firstName, lastName, image: optionalString(body.image), headline,
				profileSummary, location: optionalString(body.location), website, expertise };
			await dependencies.store.run('UPDATE users SET display_name = ?, metadata_json = ?, updated_at = ? WHERE id = ?',
				[displayName, JSON.stringify(metadata), new Date().toISOString(), actor.id]);
			return { changed: true };
		},
	};
}

function preferenceView(row: Record<string, any> | null) {
	const interval = Number(row?.real_time_polling_interval_seconds);
	return { timeZone: row?.time_zone ?? 'UTC', realTimeUpdates: row ? Number(row.real_time_updates) !== 0 : true,
		realTimePollingIntervalSeconds: [2, 5, 15, 30].includes(interval) ? interval : 5 };
}

export function createAccountPreferencesOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.preferences> {
	return { binding: CONTROL_PLANE_OPERATIONS.accounts.preferences, async handler(_input, context) {
		const actor = principal(context);
		return preferenceView(await dependencies.store.first('SELECT time_zone, real_time_updates, real_time_polling_interval_seconds FROM user_preferences WHERE user_id = ? LIMIT 1', [actor.id]));
	} };
}

export function createAccountPreferencesUpdateOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.updatePreferences> {
	return { binding: CONTROL_PLANE_OPERATIONS.accounts.updatePreferences, async handler(input, context) {
		const actor = principal(context), body = input.body as Record<string, unknown>;
		const existing = await dependencies.store.first('SELECT time_zone, real_time_updates, real_time_polling_interval_seconds FROM user_preferences WHERE user_id = ? LIMIT 1', [actor.id]);
		const timeZone = optionalString(body.timeZone) ?? String(existing?.time_zone ?? 'UTC');
		try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { throw new ControlPlaneOperationError(400, 'invalid_time_zone', 'Select a valid IANA time zone.'); }
		const realTimeUpdates = body.realTimeUpdates === undefined ? preferenceView(existing).realTimeUpdates
			: body.realTimeUpdates === true || body.realTimeUpdates === 'true' || body.realTimeUpdates === '1';
		const interval = body.realTimePollingIntervalSeconds === undefined ? preferenceView(existing).realTimePollingIntervalSeconds : Number(body.realTimePollingIntervalSeconds);
		if (![2, 5, 15, 30].includes(interval)) throw new ControlPlaneOperationError(400, 'invalid_realtime_polling_interval', 'Select a supported real-time polling interval.');
		const now = new Date().toISOString();
		await dependencies.store.run(`INSERT INTO user_preferences (user_id, color_scheme, theme_mode, time_zone, real_time_updates, real_time_polling_interval_seconds, created_at, updated_at)
			VALUES (?, 'fern', 'system', ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET time_zone = EXCLUDED.time_zone,
			real_time_updates = EXCLUDED.real_time_updates, real_time_polling_interval_seconds = EXCLUDED.real_time_polling_interval_seconds, updated_at = EXCLUDED.updated_at`,
			[actor.id, timeZone, realTimeUpdates ? 1 : 0, interval, now, now]);
		await dependencies.store.recordAuditEvent({ actorType: 'user', actorId: actor.id, eventType: 'account.preferences.updated', targetType: 'user', targetId: actor.id,
			data: { timeZone, realTimeUpdates, realTimePollingIntervalSeconds: interval } });
		return { timeZone, realTimeUpdates, realTimePollingIntervalSeconds: interval };
	} };
}

export function createAccountNotificationsOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.notifications> {
	return { binding: CONTROL_PLANE_OPERATIONS.accounts.notifications, async handler(input, context) {
		const actor = principal(context);
		const allowed = new Set((await dependencies.store.listProjectsForPrincipal(actor)).map((project) => project.id));
		const limit = Math.min(100, Math.max(1, Number(input.query.limit ?? 20)));
		const rows = await dependencies.store.all(`SELECT user_notifications.id, user_notifications.read_at, user_notifications.created_at, notification_events.*
			FROM user_notifications INNER JOIN notification_events ON notification_events.id = user_notifications.event_id
			WHERE user_notifications.user_id = ? ORDER BY user_notifications.created_at DESC LIMIT ?`, [actor.id, limit * 3]);
		return { items: rows.filter((row) => allowed.has(row.project_id)).slice(0, limit).map((row) => ({ id: row.id, eventType: row.event_type,
			contentType: row.content_type, projectId: row.project_id, title: row.title, summary: row.summary, targetUrl: row.target_url,
			createdAt: row.created_at, readAt: row.read_at })) };
	} };
}

export function createAccountNotificationReadOperation(dependencies: AccountOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.readNotification> {
	return { binding: CONTROL_PLANE_OPERATIONS.accounts.readNotification, async handler(input, context) {
		const actor = principal(context);
		const row = await dependencies.store.first('SELECT id, read_at FROM user_notifications WHERE id = ? AND user_id = ? LIMIT 1', [input.path.notificationId, actor.id]);
		if (!row) throw new ControlPlaneOperationError(404, 'notification_missing', 'The notification was not found.');
		const readAt = row.read_at ?? new Date().toISOString();
		await dependencies.store.run('UPDATE user_notifications SET read_at = ? WHERE id = ? AND user_id = ?', [readAt, row.id, actor.id]);
		return { id: row.id, readAt };
	} };
}
