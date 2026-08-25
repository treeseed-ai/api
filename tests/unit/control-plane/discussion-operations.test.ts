import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createDiscussionOperations } from '../../../src/api/control-plane/catalog/discussion-operations.ts';

describe('discussion catalog operations', () => {
	it('binds list, create, and lifecycle changes without HTTP knowledge', async () => {
		const discussions = {
			list: vi.fn(async () => ({ discussions: [] })),
			create: vi.fn(async () => ({ discussion: { id: 'discussion-1' }, replayed: false })),
			updateStatus: vi.fn(async () => ({ discussionId: 'discussion-1', status: 'archived' })),
		};
		const operations = createDiscussionOperations({ discussions });
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.discussions.list,
			CONTROL_PLANE_OPERATIONS.discussions.create,
			CONTROL_PLANE_OPERATIONS.discussions.updateStatus,
		]);
		const context = { interface: 'rest' as const, requestId: 'request-1', idempotencyKey: 'key-1', principal: { id: 'user-1' } };
		await operations[1].handler({ path: {}, query: {}, body: { teamId: 'team-1', body: 'Hello' } }, context);
		expect(discussions.create).toHaveBeenCalledWith(context.principal, { teamId: 'team-1', body: 'Hello' }, 'key-1');
		await operations[2].handler({ path: { discussionId: 'discussion-1' }, query: {}, body: { projectId: 'project-1', status: 'archived' } }, context);
		expect(discussions.updateStatus).toHaveBeenCalledWith(context.principal, 'discussion-1',
			{ projectId: 'project-1', status: 'archived' }, 'key-1');
	});
});
