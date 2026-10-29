import { describe, expect, it, vi } from 'vitest';
import { executionNodeSchema } from '@treeseed/sdk/agent-capacity';
import { workItemContext } from '../../../../../../../src/api/capacity/services/build/ready-execution-node.ts';
import { candidate } from '../../fixtures/assignment-attempt-fixtures.ts';
import { resolveAuthorizedSourceCommit } from '../../../../../../../src/api/control-plane/repositories/providers/source/source-pin.ts';

vi.mock('../../../../../../../src/security/provider-credential-authority.ts', () => ({
	resolveGitHubSourceAuthority: vi.fn(async () => null),
}));
vi.mock('../../../../../../../src/api/control-plane/repositories/providers/source/source-pin.ts', () => ({
	resolveAuthorizedSourceCommit: vi.fn(async () => 'd'.repeat(40)),
}));

describe('workday-owned planning context', () => {
	it('pins authorized read-only source before issuing a TreeDX planning assignment', async () => {
		const held = { store: 'treedx', model: 'knowledge', id: 'project-context', repository: 'library',
			commit: 'a'.repeat(40), path: 'README.md' };
		const parameters = { workdayContextByProjectId: { [candidate.node.projectId]: held } };
		const repository = { id: 'source', role: 'software', provider: 'github', owner: 'treeseed-ai',
			name: 'deployment', currentBranch: 'staging' };
		const store = { first: vi.fn(async () => ({ parameters_json: JSON.stringify(parameters) })),
			listHubRepositories: vi.fn(async () => [repository]) };
		const original = structuredClone(parameters);
		for (const kind of ['planning', 'estimating'] as const) {
			const node = executionNodeSchema.parse({ ...candidate.node, kind, pairRole: null, workItemId: undefined,
				workdayId: 'workday', workspace: 'treedx', sourceRef: { store: 'postgresql', model: 'workday', id: 'workday' },
				requestedPermissions: { content: { read: ['knowledge'], write: ['proposal'] }, tools: ['source.read'] } });
			const scope = structuredClone(node);
			expect(await workItemContext(store, node)).toEqual([held, {
				store: 'git', model: 'repository', id: 'source', repository: 'treeseed-ai/deployment', commit: 'd'.repeat(40),
			}]);
			expect(node).toEqual(scope);
		}
		expect(resolveAuthorizedSourceCommit).toHaveBeenCalledTimes(2);
		expect(parameters).toEqual(original);
	});
});
