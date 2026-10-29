import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { executionNodeSchema } from '@treeseed/sdk/agent-capacity';
import { workItemContext } from '../../../../../../../src/api/capacity/services/build/ready-execution-node.ts';
import { candidate } from '../../fixtures/assignment-attempt-fixtures.ts';
import { resolveAuthorizedSourceCommit } from '../../../../../../../src/api/control-plane/repositories/providers/source/source-pin.ts';

const gateway = vi.hoisted(() => ({ queryRepository: vi.fn(), readRepositoryFile: vi.fn() }));
vi.mock('../../../../../../../src/api/knowledge/gateway-treedx-connection.ts', async original => ({
	...await original<object>(),
	resolveKnowledgeGatewayConnection: vi.fn(async () => ({ repositoryId: 'library', contentPath: '.', client: gateway })),
}));

vi.mock('../../../../../../../src/security/provider-credential-authority.ts', () => ({
	resolveGitHubSourceAuthority: vi.fn(async () => null),
}));
vi.mock('../../../../../../../src/api/control-plane/repositories/providers/source/source-pin.ts', () => ({
	resolveAuthorizedSourceCommit: vi.fn(async () => 'd'.repeat(40)),
}));

describe('workday-owned planning context', () => {
	it('resolves the selected objective ID to its canonical path at the frozen project context commit', async () => {
		const held = { store: 'treedx', model: 'knowledge', id: 'project-context', repository: 'library',
			commit: 'a'.repeat(40), path: 'README.md' };
		const definition = { schemaVersion: 'treeseed.objective/v1', id: 'required-work', projectId: candidate.node.projectId,
			title: 'Finish retained source delivery', outcome: 'Release the real reviewed contribution.', status: 'active' };
		const path = 'objectives/release/retained-contribution.mdx', source = `---\n${JSON.stringify(definition)}\n---\n\nRequired release work.\n`;
		const parameters = { objectiveRefs: [definition.id], workdayContextByProjectId: { [candidate.node.projectId]: held } };
		const store = { first: vi.fn(async () => ({ parameters_json: JSON.stringify(parameters) })) };
		gateway.queryRepository.mockResolvedValue({ resolvedRef: held.commit, results: [{ path, frontmatter: definition }], page: { hasMore: false } });
		gateway.readRepositoryFile.mockResolvedValue({ resolvedRef: held.commit, file: { path, frontmatter: definition, content: source } });
		const node = executionNodeSchema.parse({ ...candidate.node, kind: 'planning', pairRole: null, workItemId: undefined,
			workdayId: 'workday', workspace: 'treedx', sourceRef: { store: 'postgresql', model: 'workday', id: 'workday' },
			requestedPermissions: { content: { read: ['knowledge', 'objective'], write: ['proposal'] }, tools: [] } });
		const original = structuredClone(parameters);
		expect(await workItemContext(store, node)).toEqual([held, {
			store: 'treedx', model: 'objective', id: definition.id, repository: held.repository, commit: held.commit, path,
			digest: `sha256:${createHash('sha256').update(source).digest('hex')}`,
		}]);
		expect(gateway.queryRepository).toHaveBeenCalledWith(expect.objectContaining({ repoId: held.repository,
			ref: held.commit, type: 'frontmatter', paths: ['objectives/**'],
			filters: [{ field: 'frontmatter.id', op: 'eq', value: definition.id }] }));
		expect(gateway.readRepositoryFile).toHaveBeenCalledWith(expect.objectContaining({ ref: held.commit, path }));
		expect(parameters).toEqual(original);
	});
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
