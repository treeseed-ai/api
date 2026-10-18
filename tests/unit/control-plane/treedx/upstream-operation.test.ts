import { describe, expect, it } from 'vitest';
import { requireTreeDxOperation, treeDxBoundedScopedPaths, treeDxOperationScope, treeDxPathParameters, treeDxQuery, treeDxScopedPathAllows } from '../../../../src/api/control-plane/treedx/upstream-operation.ts';

describe('authoritative TreeDX upstream operations', () => {
	it('delegates only the exact source and destination branch refs for reviewed authoring promotion', () => {
		const operation = requireTreeDxOperation('promoteRepositoryRef');
		const scope = treeDxOperationScope(operation, { path: { repoId: 'repo-owned' }, body: {
			sourceRef: 'refs/heads/knowledge/reviewed', destinationRef: 'refs/heads/staging',
			expectedDestinationHead: 'a'.repeat(40),
		} });
		expect(scope).toEqual({ repoIds: ['repo-owned'], capabilities: operation.requiredCapabilities,
			refs: ['refs/heads/knowledge/reviewed', 'refs/heads/staging'], paths: [] });
		expect(scope.refs).not.toContain('refs/heads/main');
		expect(scope.refs).not.toContain('*');
		expect(scope.refs).not.toContain('a'.repeat(40));
	});

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
		expect(treeDxOperationScope(requireTreeDxOperation('commitWorkspace'), { body: { additionalParentRefs: ['refs/heads/staging'] } }, ['repo-1']).refs).toEqual(['refs/heads/staging']);
		expect(treeDxOperationScope(requireTreeDxOperation('writeWorkspaceFiles'), { body: { files: [{path:'docs/a.md',content:'Exact bytes'}, {path:'docs/b.md',content:'Other exact bytes'}] } }, ['repo-1']).paths).toEqual(['docs/a.md','docs/b.md']);
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
