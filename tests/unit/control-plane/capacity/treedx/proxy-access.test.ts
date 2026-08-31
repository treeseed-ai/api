import { describe, expect, it } from 'vitest';
import { evaluateTreeDxProxyHandleAccess, treeDxProxyAuthorizedPathPatterns } from '../../../../../src/api/capacity/policy/treedx-proxy-access.ts';

const handle = {
	id: 'handle-1', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1', repositoryId: 'repo-1',
	allowedReadPaths: ['objectives/**', 'agents/**'], allowedWritePaths: ['proposals/**'], allowedOperations: ['files:read', 'files:write'],
};

describe('assignment TreeDX path authority', () => {
	it('projects compact authorized patterns into upstream delegation tokens', () => {
		expect(treeDxProxyAuthorizedPathPatterns(handle, 'files:read')).toEqual(['objectives/**', 'agents/**']);
		expect(treeDxProxyAuthorizedPathPatterns({ ...handle, allowedReadPaths: ['agents/**', '**', 'objectives/**'] }, 'files:read')).toEqual(['**']);
		expect(treeDxProxyAuthorizedPathPatterns(handle, 'files:write')).toEqual(['proposals/**']);
	});

	it('rejects every requested path outside the handle patterns', () => {
		const request = { teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1', repositoryId: 'repo-1', operation: 'files:read' };
		expect(evaluateTreeDxProxyHandleAccess(handle, { ...request, path: 'objectives/core.mdx' }).ok).toBe(true);
		expect(evaluateTreeDxProxyHandleAccess(handle, { ...request, path: 'secrets/value.mdx' })).toMatchObject({ ok: false, code: 'treedx_proxy_path_denied' });
	});
});
