import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createAccountEmailAddOperation, createAccountEmailPrimaryOperation, createAccountEmailRemoveOperation, createAccountEmailsOperation, createAccountEmailVerifyOperation, createAccountIdentityOperation, createAccountNotificationReadOperation, createAccountNotificationsOperation, createAccountPreferencesOperation, createAccountPreferencesUpdateOperation, createAccountProfileUpdateOperation, createAccountSessionRevokeOperation, createAccountSessionsOperation } from '../../../src/api/control-plane/catalog/account-operations.ts';

const context = { principal: { id: 'user-1', displayName: 'Adrian', metadata: { sessionId: 'current-session' } },
	interface: 'rest' as const, requestId: 'request-1' };

function dependencies() {
	const run = vi.fn(async () => undefined);
	const recordAuditEvent = vi.fn(async () => undefined);
	return { run, recordAuditEvent, value: {
		store: {
			async listTeamsForPrincipal() { return []; },
			async listProjectsForPrincipal() { return [{ id: 'project-1' }]; },
			async first(query: string) {
				if (query.includes('FROM users')) return { username: 'adrian', display_name: 'Adrian', metadata_json: '{"expertise":["systems"]}' };
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
	} as any };
}

describe('account catalog operations', () => {
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
		} }, context);
		expect(profile).toEqual({ changed: true });
		expect(preferences).toEqual({ timeZone: 'America/New_York', realTimeUpdates: true, realTimePollingIntervalSeconds: 5 });
		expect(createAccountPreferencesOperation(fixture.value).binding).toBe(CONTROL_PLANE_OPERATIONS.accounts.preferences);
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
});
