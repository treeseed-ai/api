import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createAccountAdminOperations } from '../../../../src/api/control-plane/catalog/accounts/admin-operations.ts';

const context = { principal: { id: 'user-1' }, interface: 'rest' as const, requestId: 'request-1', ifMatch: 'notification-v1' };

function fixture() {
	const rows = new Map<string, any>();
	const batch = vi.fn(async () => undefined);
	const run = vi.fn(async () => ({ meta: { changes: 1 } }));
	const dependencies = { store: {
		async first(query: string) {
			if (query.includes('COUNT(*)')) return { count: 2 };
			if (query.includes('user_notification_preferences')) return { email_cadence: 'weekly', updated_at: 'notification-v1' };
			if (query.includes('FROM users')) return { updated_at: 'account-v1' };
			return rows.get(query) ?? null;
		},
		async all(query: string) {
			if (query.includes('user_notification_global_content_types')) return [{ content_type: 'agents' }];
			if (query.includes('user_notification_project_content_types')) return [{ project_id: 'project-1', content_type: 'decisions' }];
			return [];
		},
		run, batch, recordAuditEvent: vi.fn(), listTeamsForPrincipal: vi.fn(), teamPublicNameExists: vi.fn(async () => false),
		listProjectsForPrincipal: vi.fn(async () => [{ id: 'project-1' }]),
	}, accountRegistration: {}, accountSecurity: {}, accountEmails: {}, listUserEmailAddresses: vi.fn() } as any;
	return { dependencies, rows, batch, run, operations: new Map(createAccountAdminOperations(dependencies).map((entry) => [entry.binding.descriptor.operationId, entry])) };
}

describe('Admin account catalog operations', () => {
	it('normalizes notification preferences and replaces preference rows atomically', async () => {
		const value = fixture();
		const read = value.operations.get(CONTROL_PLANE_OPERATIONS.accounts.notificationPreferences.descriptor.operationId)!;
		const update = value.operations.get(CONTROL_PLANE_OPERATIONS.accounts.updateNotificationPreferences.descriptor.operationId)!;
		expect(await read.handler({ path: {}, query: {}, body: undefined }, context)).toEqual({ emailCadence: 'weekly', globalContentTypes: ['agents'], projectOverrides: [{ projectId: 'project-1', contentTypes: ['decisions'] }], updatedAt: 'notification-v1' });
		await update.handler({ path: {}, query: {}, body: { emailCadence: 'immediate', globalContentTypes: ['agents'], projectOverrides: [] } }, context);
		expect(value.batch).toHaveBeenCalledOnce();
		expect(value.batch.mock.calls[0]![0]).toEqual(expect.arrayContaining([expect.objectContaining({ query: expect.stringContaining('DELETE FROM user_notification_global_content_types') })]));
	});

	it('rejects a stale notification preference revision before replacing rows', async () => {
		const value = fixture();
		const update = value.operations.get(CONTROL_PLANE_OPERATIONS.accounts.updateNotificationPreferences.descriptor.operationId)!;
		await expect(update.handler({ path: {}, query: {}, body: { emailCadence: 'daily', globalContentTypes: [], projectOverrides: [] } }, { ...context, ifMatch: 'stale' }))
			.rejects.toMatchObject({ status: 412, code: 'notification_preferences_precondition_failed' });
		expect(value.batch).not.toHaveBeenCalled();
	});

	it('rejects provider unlinking when it would remove the last authentication method', async () => {
		const value = fixture();
		value.dependencies.store.first = vi.fn(async (query: string) => query.includes('COUNT(*)') ? { count: 1 } : { id: 'identity-1' });
		const operation = value.operations.get(CONTROL_PLANE_OPERATIONS.accounts.unlinkProvider.descriptor.operationId)!;
		await expect(operation.handler({ path: { identityId: 'identity-1' }, query: {}, body: {} }, context)).rejects.toMatchObject({ status: 409, code: 'last_authentication_method' });
		expect(value.run).not.toHaveBeenCalled();
	});
});
