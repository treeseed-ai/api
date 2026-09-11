import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitProposalVersionContent } from '../../../../src/api/control-plane/governance/proposal-version-content.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../src/api/knowledge/gateway-treedx-connection.ts';

vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts', async (original) => ({
	...await original<typeof import('../../../../src/api/knowledge/gateway-treedx-connection.ts')>(),
	resolveKnowledgeGatewayConnection: vi.fn(),
}));

describe('proposal contract lookup failures', () => {
	beforeEach(() => vi.clearAllMocks());
	it.each([404, 401, 503])('closes the workspace and preserves failure meaning for HTTP %i', async (status) => {
		const upstreamError = Object.assign(new Error('Upstream lookup failed.'), { status });
		const client = { createWorkspace: vi.fn(async () => ({ workspaceId: 'workspace-1', baseCommitSha: 'a'.repeat(40) })),
			readRepositoryFiles: vi.fn(async () => { throw upstreamError; }), closeWorkspace: vi.fn(async () => undefined),
			commit: vi.fn() };
		vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ client, contentPath: '.', repositoryId: 'repository-1',
			authoringBranch: 'staging', allowedPaths: ['proposals/**'] } as unknown as NonNullable<Awaited<ReturnType<typeof resolveKnowledgeGatewayConnection>>>);
		const operation = commitProposalVersionContent({ store: {}, principal: { id: 'user-1' },
			proposal: { id: 'proposal-1', projectId: 'project-1', activeVersion: 1, title: 'Test proposal', proposalTypes: ['implementation'] }, update: {} });
		if (status === 404) await expect(operation).rejects.toMatchObject({ status: 422, code: 'proposal_type_contract_missing',
			paths: ['.treeseed/governance/proposal-types/implementation.yaml'], commitSha: 'a'.repeat(40),
			message: expect.stringContaining('Reconcile these contracts before publishing') });
		else await expect(operation).rejects.toBe(upstreamError);
		expect(client.closeWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1');
		expect(client.commit).not.toHaveBeenCalled();
	});
});
