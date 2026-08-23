import { describe, expect, it } from 'vitest';
import { requireTreeDxOperation, treeDxOperationScope, treeDxPathParameters, treeDxQuery } from '../../../../src/api/control-plane/treedx/upstream-operation.ts';

describe('authoritative TreeDX upstream operations', () => {
	it('derives path and least-privilege capability scope from the official package', () => {
		const operation = requireTreeDxOperation('writeWorkspaceFile');
		expect(operation.requiredCapabilities).toContain('files:write');
		expect(treeDxPathParameters(operation, { workspaceId: 'workspace one' })).toEqual({ workspace_id: 'workspace one' });
		expect(treeDxOperationScope(operation, { path: { workspaceId: 'workspace one' }, body: { path: 'docs/a.md' } }, ['repo-1']))
			.toMatchObject({ repoIds: ['repo-1'], capabilities: operation.requiredCapabilities, paths: ['docs/a.md'] });
	});

	it('does not forward TreeSeed assignment or proxy-handle query fields', () => {
		expect(treeDxQuery({ cursor: 'next', limit: 25, assignmentId: 'assignment-1', treeDxProxyToken: 'secret' }))
			.toEqual({ cursor: 'next', limit: 25 });
	});
});
