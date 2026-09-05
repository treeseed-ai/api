import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createServiceOperations } from '../../../../src/api/control-plane/catalog/services/index.ts';
import { createServiceConnectionService } from '../../../../src/api/control-plane/repositories/service-connection-service.ts';

const principal = { id: 'user-1', roles: ['team_manager'] };

describe('service provider catalog operations', () => {
	it('binds only the retained provider and authority operations', async () => {
		const services = {
			providers: vi.fn(() => ({ items: [] })), connections: vi.fn(async () => ({ items: [], cursor: null })),
			credentialStatus: vi.fn(), putCredentials: vi.fn(), deleteCredentials: vi.fn(), validateCredentials: vi.fn(),
			connection: vi.fn(async () => ({ id: 'connection-1' })), create: vi.fn(async () => ({ id: 'connection-1' })),
			update: vi.fn(async () => ({ id: 'connection-1', version: 2 })), disconnect: vi.fn(async () => ({ id: 'connection-1' })),
			authorities: vi.fn(async () => ({ items: [], cursor: null })),
		};
		const operations = createServiceOperations({ services });
		expect(operations.map((operation) => operation.binding)).toContain(CONTROL_PLANE_OPERATIONS.services.putCredentials);
		const update = operations.find((operation) => operation.binding === CONTROL_PLANE_OPERATIONS.services.updateConnection)!;
		await update.handler({ path: { teamId: 'team-1', connectionId: 'connection-1' }, query: {}, body: { displayName: 'GitHub' } },
			{ interface: 'rest', requestId: 'request-1', principal, ifMatch: '1' });
		expect(services.update).toHaveBeenCalledWith(principal, 'team-1', 'connection-1', { displayName: 'GitHub' }, '1');
	});

	it('requires exact concurrency evidence and rejects plaintext credentials', async () => {
		const store = {
			principalCanAccessTeam: vi.fn(async () => true),
			getTeamAccessSummary: vi.fn(async () => ({ permissions: ['services:manage:team'] })),
			getTeamServiceConnection: vi.fn(async () => ({ id: 'connection-1', providerId: 'github', version: 2, capabilities: [] })),
			createTeamServiceConnection: vi.fn(), updateTeamServiceConnection: vi.fn(),
		};
		const service = createServiceConnectionService(store);
		await expect(service.update(principal, 'team-1', 'connection-1', { displayName: 'GitHub' }, '1')).rejects.toMatchObject({
			status: 412, code: 'service_connection_precondition_failed',
		});
		await expect(service.create(principal, 'team-1', { providerId: 'github', displayName: 'GitHub', accessToken: 'secret' }))
			.rejects.toMatchObject({ status: 400, code: 'plaintext_secret_rejected' });
		expect(store.createTeamServiceConnection).not.toHaveBeenCalled();
		expect(store.updateTeamServiceConnection).not.toHaveBeenCalled();
	});
});
