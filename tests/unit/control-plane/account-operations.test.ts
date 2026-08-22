import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createAccountEmailsOperation, createAccountIdentityOperation, createAccountSessionRevokeOperation, createAccountSessionsOperation } from '../../../src/api/control-plane/catalog/account-operations.ts';

const context = { principal: { id: 'user-1', displayName: 'Adrian', metadata: { sessionId: 'current-session' } },
	interface: 'rest' as const, requestId: 'request-1' };

function dependencies() {
	const run = vi.fn(async () => undefined);
	const recordAuditEvent = vi.fn(async () => undefined);
	return { run, recordAuditEvent, value: {
		store: {
			async listTeamsForPrincipal() { return []; },
			async first(query: string) {
				if (query.includes('FROM users')) return { username: 'adrian', display_name: 'Adrian', metadata_json: '{"expertise":["systems"]}' };
				if (query.includes('control_plane_auth_credentials')) return { user_id: 'user-1' };
				return { revoked_at: null };
			},
			async all(query: string) { return query.includes('auth_sessions') ? [{ id: 'session-2', session_type: 'oauth', data_json: '{}', created_at: '2026-08-21T00:00:00Z', updated_at: '2026-08-21T00:00:00Z' }] : []; },
			run, recordAuditEvent,
		},
		async listUserEmailAddresses() { return [{ id: 'email-1', email: 'adrian@example.test' }]; },
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
});
