import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { expect, it, vi } from 'vitest';
const gateway = vi.hoisted(() => ({ readRepositoryFile: vi.fn() }));
vi.mock('../../../../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
 resolveKnowledgeGatewayConnection: vi.fn(async () => ({ repositoryId: 'repository', client: gateway })),
}));
import { resolveKnowledgeGatewayConnection } from '../../../../../../../src/api/knowledge/gateway-treedx-connection.ts';
import { workItemContext } from '../../../../../../../src/api/capacity/services/build/ready-execution-node.ts';
import { readyContributionProposal } from '../../../../governance/proposals/architecture/ready-proposal-fixture.ts';
const sourceRef = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1,
 digest: `sha256:${'a'.repeat(64)}`, repository: 'repository', commit: 'b'.repeat(40), path: 'proposals/one.mdx' };
const permissions = { content: { read: ['proposal', 'decision'], write: [] }, tools: ['source.read'] };
// Controlled UNIT content; native SQL/HTTP/Git owner proof is adjacent.
it('reads shared planning proposal context through its owning project binding and refuses a foreign team', async () => {
	for (const kind of ['planning', 'estimating']) for (const teamId of ['team', 'foreign-team']) {
		vi.mocked(resolveKnowledgeGatewayConnection).mockImplementation(async (_store, input) => ({
			repositoryId: input.projectId === 'ui' ? 'repository' : 'admin-library', client: gateway,
		}) as never);
		const proposal = readyContributionProposal(), sharedGit = { store: 'git' as const, model: 'repository', id: 'ui-source', repository: 'treeseed-ai/ui', commit: 'e'.repeat(40) };
		Object.assign(proposal, { id: 'proposal', projectId: 'ui', groupIds: ['portfolio-atlas'] });
		Object.assign(proposal.executionPlan.workItems[0]!, { contextRefs: [sharedGit] });
		const content = `---\n${stringify(proposal)}---\n`, exactRef = { ...sourceRef, digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
		gateway.readRepositoryFile.mockResolvedValue({ resolvedRef: sourceRef.commit, file: { content, frontmatter: proposal } });
		const fetchImpl = vi.fn(async () => new Response('d'.repeat(40)));
		const store = { getGovernanceProposal: async () => ({ id: 'proposal', projectId: 'ui', teamId }),
			getProjectTreeDxLibrary: async () => ({ repositoryId: 'repository' }), config: { fetchImpl }, all: async () => [],
			listHubRepositories: async () => [{ id: 'admin-source', role: 'software', provider: 'github', owner: 'treeseed-ai', name: 'admin', currentBranch: 'staging' }] };
		const read = workItemContext(store, { id: 'shared-planning', projectId: 'admin', teamId: 'team',
			kind, workItemId: null, sourceRef: exactRef, requestedPermissions: permissions } as never);
		if (teamId === 'team') expect(await read).toEqual([exactRef, sharedGit, { store: 'git', model: 'repository',
			id: 'admin-source', repository: 'treeseed-ai/admin', commit: 'd'.repeat(40) }]);
		else await expect(read).rejects.toMatchObject({ code: 'execution_node_source_invalid' });
	}
	vi.mocked(resolveKnowledgeGatewayConnection).mockImplementation(async () => ({ repositoryId: 'repository', client: gateway }) as never);
});
