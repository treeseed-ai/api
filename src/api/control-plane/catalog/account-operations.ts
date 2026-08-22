import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { ControlPlaneOperationError, type BoundOperation } from './operation-registry.ts';

export interface AccountOperationDependencies {
	store: {
		listTeamsForPrincipal(principal: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
		first(query: string, parameters?: unknown[]): Promise<Record<string, any> | null>;
		all(query: string, parameters?: unknown[]): Promise<Array<Record<string, any>>>;
		run(query: string, parameters?: unknown[]): Promise<unknown>;
		recordAuditEvent(event: Record<string, unknown>): Promise<unknown>;
	};
	listUserEmailAddresses(userId: string): Promise<Array<Record<string, unknown>>>;
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
