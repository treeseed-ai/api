import { describe, expect, it } from 'vitest';
import { requireTreeDxOperation, treeDxBoundedScopedPaths, treeDxOperationScope, treeDxPathParameters, treeDxQuery, treeDxScopedPathAllows } from '../../../../src/api/control-plane/treedx/upstream-operation.ts';

describe('authoritative TreeDX upstream operations', () => {
	it('derives exact current workspace metadata and closeout scope from official capabilities while retaining the exact repository', () => {
		for (const id of ['getWorkspace', 'closeWorkspace']) {
			const operation = requireTreeDxOperation(id);
			expect(operation.requiredCapabilities).toEqual(['files:read', 'workspace:same_actor']);
			expect(treeDxOperationScope(operation, { path: { workspaceId: 'workspace-owned' } }, ['repo-owned']))
				.toMatchObject({ repoIds: ['repo-owned'], capabilities: operation.requiredCapabilities });
		}
	});
	it('delegates the complete graph refresh capability closure', () => {
		const operation = requireTreeDxOperation('refreshRepositoryGraph');
		expect(operation.requiredCapabilities).toEqual(['files:read', 'git:read', 'graph:refresh']);
		expect(treeDxOperationScope(operation, { body: { ref: 'a'.repeat(40), paths: ['knowledge/**'] } }, ['repo-1']))
			.toMatchObject({ repoIds: ['repo-1'], capabilities: ['files:read', 'git:read', 'graph:refresh'] });
	});

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

	it('authorizes the physical candidates for an extensionless content read', () => {
		const operation = requireTreeDxOperation('readRepositoryFile');
		expect(treeDxOperationScope(operation, { body: { paths: ['objectives/core'] } }, ['repo-1']).paths)
			.toEqual(['objectives/core', 'objectives/core.mdx', 'objectives/core.md', 'objectives/core.markdown',
				'objectives/core.json', 'objectives/core.yaml', 'objectives/core.yml', 'objectives/core.toml']);
		expect(treeDxScopedPathAllows('objectives/core', 'objectives/core.mdx')).toBe(true);
		expect(treeDxScopedPathAllows('objectives/core', 'objectives/core.exe')).toBe(false);
		expect(treeDxBoundedScopedPaths(['objectives/core'], ['objectives/core', 'objectives/core.mdx', 'objectives/core.exe']))
			.toEqual(['objectives/core', 'objectives/core.mdx']);
	});
});
