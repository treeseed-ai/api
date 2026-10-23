import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitProposalVersionContent } from '../../../../src/api/control-plane/governance/proposal-version-content.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../src/api/knowledge/gateway-treedx-connection.ts';

vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts', async (original) => ({
	...await original<typeof import('../../../../src/api/knowledge/gateway-treedx-connection.ts')>(),
	resolveKnowledgeGatewayConnection: vi.fn(),
}));

describe('proposal contract lookup failures', () => {
	beforeEach(() => vi.clearAllMocks());
	it('requires the exact governed library contract while preserving mutable authoring custody and denying local fallback', async () => {
		const local='a'.repeat(40), governed='b'.repeat(40), protectedRef='refs/remotes/origin/staging';
		const contract={schemaVersion:'treeseed.proposal-type/v1',id:'implementation',label:'Implementation',description:'Bounded work.'};
		const reachedLocalSource=new Error('Contract authority passed; original local source read reached.');
		const client={createWorkspace:vi.fn(async()=>({workspaceId:'workspace-1',baseCommitSha:local})),
			listRepositoryRefs:vi.fn(async()=>[{name:protectedRef,target:governed}]),
			readRepositoryFiles:vi.fn(async(input:{ref:string})=>{if(input.ref!==protectedRef)throw Object.assign(new Error('No contract on local discussion branch'),{status:404});return{resolvedRef:governed,files:[{path:'.treeseed/governance/proposal-types/implementation.yaml',content:JSON.stringify(contract)}]};}),
			readRepositoryFile:vi.fn(async()=>{throw reachedLocalSource;}),closeWorkspace:vi.fn(async()=>undefined),commit:vi.fn()};
		vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({client,contentPath:'.',repositoryId:'repository-1',baseRef:protectedRef,authoringBranch:'staging',allowedPaths:['proposals/**']} as never);
		const input={store:{},principal:{id:'user-1'},proposal:{id:'proposal-1',projectId:'project-1',title:'Bounded repair',body:'Repair the observed boundary.',proposalTypes:['implementation']},update:{}};
		await expect(commitProposalVersionContent(input)).rejects.toBe(reachedLocalSource);
		expect(client.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({baseRef:'refs/heads/staging'}));
		expect(client.readRepositoryFiles).toHaveBeenCalledWith(expect.objectContaining({ref:protectedRef}));
		expect(client.readRepositoryFile).toHaveBeenCalledWith(expect.objectContaining({ref:'refs/heads/staging'}));
		client.readRepositoryFiles.mockRejectedValueOnce(Object.assign(new Error('Governed contract missing'),{status:404}));
		await expect(commitProposalVersionContent(input)).rejects.toMatchObject({code:'proposal_type_contract_missing',commitSha:governed});
		client.readRepositoryFiles.mockResolvedValueOnce({resolvedRef:'c'.repeat(40),files:[]});
		await expect(commitProposalVersionContent(input)).rejects.toMatchObject({code:'proposal_contract_base_stale',expectedBase:governed});
		expect(client.commit).not.toHaveBeenCalled();
		for(const refs of [[],[{name:protectedRef,target:governed},{name:protectedRef,target:'c'.repeat(40)}]]){
			client.listRepositoryRefs.mockResolvedValueOnce(refs);
			await expect(commitProposalVersionContent(input)).rejects.toMatchObject({code:'proposal_contract_authority_unavailable',status:503});
		}
		expect(client.closeWorkspace).toHaveBeenCalledTimes(5);
	});
	it.each([401, 503])('does not treat existing-source HTTP %i as a missing file', async (status) => {
		const failure = Object.assign(new Error('Source unavailable'), { status });
		const client = { createWorkspace: vi.fn(async () => ({ workspaceId: 'workspace-1', baseCommitSha: 'a'.repeat(40) })),
			readRepositoryFiles: vi.fn(async () => ({ resolvedRef: 'a'.repeat(40), files: [{ path: '.treeseed/governance/proposal-types/implementation.yaml',
				content: JSON.stringify({ schemaVersion: 'treeseed.proposal-type/v1', id: 'implementation', label: 'Implementation', description: 'Bounded change.' }) }] })),
			readRepositoryFile: vi.fn(async () => { throw failure; }), applyChangeset: vi.fn(), closeWorkspace: vi.fn(async () => undefined), commit: vi.fn() };
		vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ client, contentPath: '.', repositoryId: 'repository-1',
			baseRef: 'a'.repeat(40), authoringBranch: 'staging', allowedPaths: ['proposals/**'] } as unknown as NonNullable<Awaited<ReturnType<typeof resolveKnowledgeGatewayConnection>>>);
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
			baseRef: 'a'.repeat(40), authoringBranch: 'staging', allowedPaths: ['proposals/**'] } as unknown as NonNullable<Awaited<ReturnType<typeof resolveKnowledgeGatewayConnection>>>);
		await expect(commitProposalVersionContent({ store: {}, principal: { id: 'user-1' },
			proposal: { id: 'proposal-1', projectId: 'project-1', activeVersion: 1, title: 'Test proposal', summary: 'Verify source custody.', body: 'Test body.', proposalTypes: ['implementation'],
				metadata: { plan: { desiredOutcome: 'Verified source', currentProblem: 'Digest mismatch', proposedApproach: 'Compare bytes',
					scope: [], nonGoals: [], deliverables: [], acceptanceCriteria: [], risks: [], dependencies: [], alternatives: [], verification: [] } } }, update: { groupIds: ['portfolio-runtime'] } })).rejects.toMatchObject({ status: 409, code: 'proposal_changeset_digest_mismatch' });
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
			baseRef: 'a'.repeat(40), authoringBranch: 'staging', allowedPaths: ['proposals/**'] } as unknown as NonNullable<Awaited<ReturnType<typeof resolveKnowledgeGatewayConnection>>>);
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
