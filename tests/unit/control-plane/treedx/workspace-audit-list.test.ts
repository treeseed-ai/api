import { describe, expect, it, vi } from 'vitest';
import { createTreeDxProxyOperationService } from '../../../../src/api/control-plane/repositories/treedx/proxy-operation-service.ts';

describe('TreeDX workspace audit inventory', () => {
	it('uses the audit record identity and does not require a nonexistent upstream request column', async () => {
		const all = vi.fn(async () => [{ id: 'audit-1', metadata_json: '{"workspaceId":"ws_12345678"}', created_at: '2026-09-15T00:00:00.000Z' }]);
		const store = {
			getProjectDetails: vi.fn(async () => ({ project: { id: 'project-1', teamId: 'team-1' } })),
			principalCanAccessTeam: vi.fn(async () => true),
			all,
		} as never;
		const service = createTreeDxProxyOperationService(store, {} as never);
		const result = await service.listWorkspaces('project-1', {}, {
			interface: 'cli', requestId: 'request-1',
			principal: { id: 'user-1', roles: ['platform_admin'], permissions: ['*:*:*'] },
		} as never);

		expect(all).toHaveBeenCalledWith(expect.stringContaining('SELECT id, metadata_json, created_at'), ['project-1']);
		expect(result).toEqual({ items: [{ requestId: 'audit-1', createdAt: '2026-09-15T00:00:00.000Z', metadata: { workspaceId: 'ws_12345678' } }] });
	});
});
