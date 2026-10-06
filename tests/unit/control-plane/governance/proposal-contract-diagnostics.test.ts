import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitProposalVersionContent } from '../../../../src/api/control-plane/governance/proposal-version-content.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../src/api/knowledge/gateway-treedx-connection.ts';

vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts', async (original) => ({
	...await original<typeof import('../../../../src/api/knowledge/gateway-treedx-connection.ts')>(),
	resolveKnowledgeGatewayConnection: vi.fn(),
}));

describe('proposal contract lookup failures', () => {
	beforeEach(() => vi.clearAllMocks());
	it.each([401, 503])('does not treat existing-source HTTP %i as a missing file', async (status) => {
		const failure = Object.assign(new Error('Source unavailable'), { status });
		const client = { createWorkspace: vi.fn(async () => ({ workspaceId: 'workspace-1', baseCommitSha: 'a'.repeat(40) })),
			readRepositoryFiles: vi.fn(async () => ({ resolvedRef: 'a'.repeat(40), files: [{ path: '.treeseed/governance/proposal-types/implementation.yaml',
				content: JSON.stringify({ schemaVersion: 'treeseed.proposal-type/v1', id: 'implementation', label: 'Implementation', description: 'Bounded change.' }) }] })),
			readRepositoryFile: vi.fn(async () => { throw failure; }), applyChangeset: vi.fn(), closeWorkspace: vi.fn(async () => undefined), commit: vi.fn() };
		vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ client, contentPath: '.', repositoryId: 'repository-1',
			authoringBranch: 'staging', allowedPaths: ['proposals/**'] } as unknown as NonNullable<Awaited<ReturnType<typeof resolveKnowledgeGatewayConnection>>>);
		await expect(commitProposalVersionContent({ store: {}, principal: { id: 'user-1' },
			proposal: { id: 'proposal-1', projectId: 'project-1', activeVersion: 1, title: 'Test proposal', summary: 'Verify source custody.', body: 'Test body.', proposalTypes: ['implementation'],
				metadata: { plan: { desiredOutcome: 'Verified source', currentProblem: 'Digest mismatch', proposedApproach: 'Compare bytes',
					scope: [], nonGoals: [], deliverables: [], acceptanceCriteria: [], risks: [], dependencies: [], alternatives: [], verification: [] } } }, update: {} })).rejects.toBe(failure);
		expect(client.applyChangeset).not.toHaveBeenCalled();
		expect(client.commit).not.toHaveBeenCalled();
		expect(client.closeWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1');
	});
	it.each([undefined, 'b'.repeat(64)])('preserves existing bytes and rejects invalid changeset evidence before committing (%s)', async (afterSha256) => {
		const path = 'proposals/governance/test-proposal.mdx';
		const client = { createWorkspace: vi.fn(async () => ({ workspaceId: 'workspace-1', baseCommitSha: 'a'.repeat(40) })),
			readRepositoryFiles: vi.fn(async () => ({ resolvedRef: 'a'.repeat(40), files: [{ path: '.treeseed/governance/proposal-types/implementation.yaml',
				content: JSON.stringify({ schemaVersion: 'treeseed.proposal-type/v1', id: 'implementation', label: 'Implementation', description: 'Bounded change.' }) }] })),
			readRepositoryFile: vi.fn(async () => ({ resolvedRef: 'a'.repeat(40), file: { content: '  existing\n\n\n' } })), applyChangeset: vi.fn(async (_input: unknown) => ({ files: [{ path, afterSha256 }] })),
			closeWorkspace: vi.fn(async () => undefined), commit: vi.fn() };
		vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ client, contentPath: '.', repositoryId: 'repository-1',
			authoringBranch: 'staging', allowedPaths: ['proposals/**'] } as unknown as NonNullable<Awaited<ReturnType<typeof resolveKnowledgeGatewayConnection>>>);
		await expect(commitProposalVersionContent({ store: {}, principal: { id: 'user-1' },
			proposal: { id: 'proposal-1', projectId: 'project-1', activeVersion: 1, title: 'Test proposal', summary: 'Verify source custody.', body: 'Test body.', proposalTypes: ['implementation'],
				metadata: { plan: { desiredOutcome: 'Verified source', currentProblem: 'Digest mismatch', proposedApproach: 'Compare bytes',
					scope: [], nonGoals: [], deliverables: [], acceptanceCriteria: [], risks: [], dependencies: [], alternatives: [], verification: [] } } }, update: {} })).rejects.toMatchObject({ status: 409, code: 'proposal_changeset_digest_mismatch' });
		expect(client.commit).not.toHaveBeenCalled();
		expect(client.applyChangeset.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ patch: expect.stringContaining('-  existing\n-\n-\n') }));
		expect(client.closeWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1');
	});

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
