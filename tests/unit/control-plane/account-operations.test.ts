import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createAccountDeleteOperation, createAccountDeletionBlockersOperation, createAccountEmailAddOperation, createAccountEmailConfirmOperation, createAccountEmailPrimaryOperation, createAccountEmailRemoveOperation, createAccountEmailsOperation, createAccountEmailVerifyOperation, createAccountIdentityOperation, createAccountNotificationReadOperation, createAccountNotificationsOperation, createAccountPasswordResetCompleteOperation, createAccountPasswordResetRequestOperation, createAccountPasswordUpdateOperation, createAccountPreferencesOperation, createAccountPreferencesUpdateOperation, createAccountProfileUpdateOperation, createAccountPublicProfileOperation, createAccountRegisterOperation, createAccountSessionRevokeOperation, createAccountSessionsOperation } from '../../../src/api/control-plane/catalog/account-operations.ts';
import { createAccountSecurityService } from '../../../src/api/control-plane/accounts/account-security-service.ts';

const context = { principal: { id: 'user-1', displayName: 'Adrian', metadata: { sessionId: 'current-session' } },
	interface: 'rest' as const, requestId: 'request-1', ifMatch: 'account-v1' };

function dependencies() {
	const run = vi.fn(async (query: string, parameters?: unknown[]) => ({ meta: { changes: query.includes('COALESCE(updated_at') && parameters?.at(-1) !== 'account-v1' ? 0 : 1 } }));
	const recordAuditEvent = vi.fn(async () => undefined);
	return { run, recordAuditEvent, value: {
		store: {
			async loadUserProfileByUsername(username: string) { return username === 'adrian' ? { user: { username: 'adrian', displayName: 'Adrian' }, knowledge: [] } : null; },
			async listTeamsForPrincipal() { return []; },
			async listProjectsForPrincipal() { return [{ id: 'project-1' }]; },
			async first(query: string) {
				if (query.includes('FROM users')) return { username: 'adrian', display_name: 'Adrian', metadata_json: '{"expertise":["systems"]}', updated_at: 'account-v1' };
				if (query.includes('control_plane_auth_credentials')) return { user_id: 'user-1' };
				return { revoked_at: null };
			},
			async all(query: string) { return query.includes('auth_sessions') ? [{ id: 'session-2', session_type: 'oauth', data_json: '{}', created_at: '2026-08-21T00:00:00Z', updated_at: '2026-08-21T00:00:00Z' }] : []; },
			run, recordAuditEvent,
		},
		async listUserEmailAddresses() { return [{ id: 'email-1', email: 'adrian@example.test' }]; },
		accountEmails: {
			async add() { return { ok: true, emailAddress: { id: 'email-2' }, verificationSent: true }; },
			async verify() { return { ok: true, emailAddress: { id: 'email-2' }, verificationSent: true }; },
			async makePrimary() { return { ok: true, emailAddress: { id: 'email-1', isPrimary: true } }; },
			async remove() { return { ok: true, items: [{ id: 'email-1' }] }; },
		},
		accountRegistration: {
			async register() { return { ok: true, confirmationRequired: true, email: 'adrian@example.test', expiresInSeconds: 3600 }; },
			async confirm() { return { ok: true, confirmed: true }; },
		},
		accountSecurity: {
			async updatePassword() { return { ok: true, changed: true }; },
			async requestPasswordReset() { return { ok: true, sent: true }; },
			async completePasswordReset() { return { ok: true, changed: true }; },
			async deletionBlockers() { return { blockers: [], canDelete: true }; },
			async removeAccount() { return { ok: true, deleted: true }; },
		},
	} as any };
}

describe('account catalog operations', () => {
	it('serves public user profiles without requiring a principal', async () => {
		const operation = createAccountPublicProfileOperation(dependencies().value);
		await expect(operation.handler({ path: { username: 'adrian' }, query: {}, body: undefined }, { interface: 'rest', requestId: 'public-1' }))
			.resolves.toMatchObject({ user: { username: 'adrian' } });
		await expect(operation.handler({ path: { username: 'missing' }, query: {}, body: undefined }, { interface: 'rest', requestId: 'public-2' }))
			.rejects.toMatchObject({ status: 404, code: 'user_profile_missing' });
		expect(operation.binding).toBe(CONTROL_PLANE_OPERATIONS.accounts.publicProfile);
	});
	it('projects identity, emails, and sessions without transport-owned behavior', async () => {
		const fixture = dependencies();
		const input = { path: {}, query: {}, body: undefined };
		const identity = await createAccountIdentityOperation(fixture.value).handler(input, context);
		const emails = await createAccountEmailsOperation(fixture.value).handler(input, context);
		const sessions = await createAccountSessionsOperation(fixture.value).handler(input, context);
		expect(identity).toMatchObject({ id: 'user-1', username: 'adrian', hasCredential: true, expertise: ['systems'] });
		expect(emails).toEqual({ items: [{ id: 'email-1', email: 'adrian@example.test' }] });
		expect(sessions).toMatchObject({ items: [{ id: 'session-2', current: false }] });
		expect(createAccountIdentityOperation(fixture.value).binding).toBe(CONTROL_PLANE_OPERATIONS.accounts.identity);
	});

	it('revokes a non-current session with an audit receipt', async () => {
		const fixture = dependencies();
		const operation = createAccountSessionRevokeOperation(fixture.value);
		const output = await operation.handler({ path: { sessionId: 'session-2' }, query: {}, body: {} }, context);
		expect(output).toEqual({ id: 'session-2', status: 'revoked' });
		expect(fixture.run).toHaveBeenCalledOnce();
		expect(fixture.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'auth.session.revoked' }));
		expect(operation.binding).toBe(CONTROL_PLANE_OPERATIONS.accounts.revokeSession);
	});

	it('updates profile and preferences through API-owned validation', async () => {
		const fixture = dependencies();
		const profile = await createAccountProfileUpdateOperation(fixture.value).handler({ path: {}, query: {}, body: {
			displayName: 'Adrian Webb', website: 'https://example.test', expertise: ['systems'],
		} }, context);
		const preferences = await createAccountPreferencesUpdateOperation(fixture.value).handler({ path: {}, query: {}, body: {
			timeZone: 'America/New_York', realTimeUpdates: true, realTimePollingIntervalSeconds: 5,
		} }, { ...context, ifMatch: '0' });
		expect(profile).toMatchObject({ changed: true, updatedAt: expect.any(String) });
		expect(preferences).toMatchObject({ timeZone: 'America/New_York', realTimeUpdates: true, realTimePollingIntervalSeconds: 5, updatedAt: expect.any(String) });
		expect(createAccountPreferencesOperation(fixture.value).binding).toBe(CONTROL_PLANE_OPERATIONS.accounts.preferences);
	});

	it('rejects stale account and preference revisions without mutation', async () => {
		const fixture = dependencies();
		await expect(createAccountProfileUpdateOperation(fixture.value).handler({ path: {}, query: {}, body: { displayName: 'Changed' } }, { ...context, ifMatch: 'stale' }))
			.rejects.toMatchObject({ status: 412, code: 'account_precondition_failed' });
		await expect(createAccountPreferencesUpdateOperation(fixture.value).handler({ path: {}, query: {}, body: { timeZone: 'UTC' } }, { ...context, ifMatch: 'stale' }))
			.rejects.toMatchObject({ status: 412, code: 'account_preferences_precondition_failed' });
		expect(fixture.run).toHaveBeenCalledTimes(1);
		expect(fixture.run.mock.calls[0]?.[0]).toContain('COALESCE(updated_at');
	});

	it('filters notifications by accessible projects and marks one read', async () => {
		const fixture = dependencies();
		fixture.value.store.all = async (query: string) => query.includes('notification_events') ? [{
			id: 'notification-1', project_id: 'project-1', event_type: 'assignment.updated', created_at: '2026-08-21T00:00:00Z',
		}, { id: 'hidden', project_id: 'project-2' }] : [];
		fixture.value.store.first = async () => ({ id: 'notification-1', read_at: null });
		const listed = await createAccountNotificationsOperation(fixture.value).handler({ path: {}, query: { limit: 20 }, body: undefined }, context);
		const read = await createAccountNotificationReadOperation(fixture.value).handler({ path: { notificationId: 'notification-1' }, query: {}, body: {} }, context);
		expect(listed).toMatchObject({ items: [{ id: 'notification-1', projectId: 'project-1' }] });
		expect(read).toMatchObject({ id: 'notification-1', readAt: expect.any(String) });
	});

	it('uses API-owned email custody without returning session credentials', async () => {
		const fixture = dependencies();
		const added = await createAccountEmailAddOperation(fixture.value).handler({ path: {}, query: {}, body: { email: 'new@example.test' } }, context);
		const verified = await createAccountEmailVerifyOperation(fixture.value).handler({ path: { emailId: 'email-2' }, query: {}, body: {} }, context);
		const primary = await createAccountEmailPrimaryOperation(fixture.value).handler({ path: { emailId: 'email-1' }, query: {}, body: {} }, context);
		const removed = await createAccountEmailRemoveOperation(fixture.value).handler({ path: { emailId: 'email-2' }, query: {}, body: {} }, context);
		expect(added).toMatchObject({ verificationSent: true });
		expect(verified).toMatchObject({ verificationSent: true });
		expect(primary).toEqual({ emailAddress: { id: 'email-1', isPrimary: true } });
		expect(removed).toEqual({ items: [{ id: 'email-1' }] });
		expect(JSON.stringify([added, verified, primary, removed])).not.toMatch(/accessToken|refreshToken|sessionToken/iu);
	});

	it('registers and confirms without minting web-session credentials', async () => {
		const fixture = dependencies();
		const registered = await createAccountRegisterOperation(fixture.value).handler({ path: {}, query: {}, body: {
			email: 'adrian@example.test', username: 'adrian', password: 'redacted-password',
		} }, { interface: 'rest', requestId: 'request-public' });
		const confirmed = await createAccountEmailConfirmOperation(fixture.value).handler({ path: {}, query: {}, body: {
			token: 'redacted-token',
		} }, { interface: 'rest', requestId: 'request-public' });
		expect(registered).toMatchObject({ confirmationRequired: true, email: 'adrian@example.test' });
		expect(confirmed).toEqual({ ok: true, confirmed: true });
		expect(JSON.stringify([registered, confirmed])).not.toMatch(/accessToken|refreshToken|sessionToken/iu);
		expect(createAccountRegisterOperation(fixture.value).binding).toBe(CONTROL_PLANE_OPERATIONS.accounts.register);
	});

	it('routes password and account deletion through the API security service', async () => {
		const fixture = dependencies();
		const body = { currentPassword: 'redacted-current', password: 'redacted-new-password' };
		expect(await createAccountPasswordUpdateOperation(fixture.value).handler({ path: {}, query: {}, body }, context)).toMatchObject({ changed: true });
		expect(await createAccountPasswordResetRequestOperation(fixture.value).handler({ path: {}, query: {}, body: { email: 'adrian@example.test' } }, context)).toMatchObject({ sent: true });
		expect(await createAccountPasswordResetCompleteOperation(fixture.value).handler({ path: {}, query: {}, body: { token: 'redacted', password: 'redacted-new-password' } }, context)).toMatchObject({ changed: true });
		expect(await createAccountDeletionBlockersOperation(fixture.value).handler({ path: {}, query: {}, body: undefined }, context)).toEqual({ blockers: [], canDelete: true });
		expect(await createAccountDeleteOperation(fixture.value).handler({ path: {}, query: {}, body: { confirmation: 'DELETE MY ACCOUNT' } }, context)).toMatchObject({ deleted: true });
	});

	it('claims a password reset token atomically before changing the credential', async () => {
		const statements: string[] = [];
		const store = {
			ensureInitialized: vi.fn(),
			async first(query: string) {
				statements.push(query);
				return query.startsWith('UPDATE control_plane_auth_password_resets') ? { id: 'reset-1', user_id: 'user-1' } : null;
			},
			async run(query: string) { statements.push(query); },
			recordAuditEvent: vi.fn(),
		};
		const service = createAccountSecurityService(store, {});
		await expect(service.completePasswordReset({ token: 'reset_secret', password: 'a sufficiently long password' }))
			.resolves.toMatchObject({ ok: true, changed: true });
		expect(statements[0]).toContain('used_at IS NULL');
		expect(statements[0]).toContain('RETURNING id, user_id');
		expect(statements[1]).toContain('UPDATE control_plane_auth_credentials');
	});

	it('does not change a password when the atomic reset claim loses a race', async () => {
		const run = vi.fn();
		const service = createAccountSecurityService({ ensureInitialized: vi.fn(), first: vi.fn(async () => null), run,
			recordAuditEvent: vi.fn() }, {});
		await expect(service.completePasswordReset({ token: 'reset_secret', password: 'a sufficiently long password' }))
			.resolves.toMatchObject({ ok: false, status: 401, code: 'invalid_password_reset' });
		expect(run).not.toHaveBeenCalled();
	});
});
