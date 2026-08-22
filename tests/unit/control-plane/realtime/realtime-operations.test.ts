import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createRealtimeOperations } from '../../../../src/api/control-plane/catalog/realtime/index.ts';
import { createRealtimeOperationService } from '../../../../src/api/control-plane/realtime/realtime-operation-service.ts';

describe('realtime catalog operations', () => {
	it('binds all five SDK-owned realtime operations', () => {
		const operations = createRealtimeOperations({ realtime: {} as any });
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.realtime.events,
			CONTROL_PLANE_OPERATIONS.realtime.createSession,
			CONTROL_PLANE_OPERATIONS.realtime.heartbeat,
			CONTROL_PLANE_OPERATIONS.realtime.actions,
			CONTROL_PLANE_OPERATIONS.realtime.actionResult,
		]);
	});

	it('returns cursor-based durable events instead of a route-owned SSE loop', async () => {
		const service = createRealtimeOperationService({
			async resolvePrincipalTeamContext() { return { roles: ['member'] }; },
		} as any, { async list() { return [{ sequence: 8 }]; } } as any);
		await expect(service.events({ id: 'user-1' }, { teamId: 'team-1', after: '7', limit: '1' })).resolves.toEqual({ items: [{ sequence: 8 }], nextCursor: '8' });
	});

	it('rejects project sessions outside the principal team context', async () => {
		const service = createRealtimeOperationService({
			async getProject() { return { id: 'project-1', teamId: 'team-1' }; },
			async resolvePrincipalTeamContext() { return null; },
		} as any, {} as any);
		await expect(service.createSession({ id: 'user-1' }, { projectId: 'project-1', route: '/projects/project-1', capabilities: ['navigate'] }))
			.rejects.toMatchObject({ status: 403, code: 'project_access_denied' });
	});

	it('accepts PostgreSQL meta change receipts for heartbeat and action settlement', async () => {
		const store = {
			async run() { return { meta: { changes: 1 } }; },
			async first(query: string) { return query.includes('agent_client_sessions') ? { id: 'session-1' } : { id: 'action-1', status: 'completed' }; },
		} as any;
		const service = createRealtimeOperationService(store, {} as any);
		await expect(service.heartbeat({ id: 'user-1' }, 'session-1')).resolves.toMatchObject({ id: 'session-1' });
		await expect(service.actionResult({ id: 'user-1' }, 'session-1', 'action-1', { status: 'completed' })).resolves.toMatchObject({ id: 'action-1' });
	});
});
