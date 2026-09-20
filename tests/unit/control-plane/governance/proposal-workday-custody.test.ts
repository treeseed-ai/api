import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitProposalVersionContent } from '../../../../src/api/control-plane/governance/proposal-version-content.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../src/api/knowledge/gateway-treedx-connection.ts';
import { CapacityWorkdayRunRepository } from '../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
import { recordTreeDxAuthoringState } from '../../../../src/api/capacity/services/treedx/repositories/treedx-authoring-journal.ts';
import { projectTreeDxCommitSignals } from '../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts';

vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts', async original => ({
	...await original<typeof import('../../../../src/api/knowledge/gateway-treedx-connection.ts')>(), resolveKnowledgeGatewayConnection: vi.fn(),
}));
vi.mock('../../../../src/api/governance/proposal-document.ts', () => ({ serializeProposalDocument: () => 'next' }));
vi.mock('../../../../src/api/knowledge/changesets/apply-text-changeset.ts', () => ({ applyTextChangeset: async () => ({
	files: [{ path: 'proposals/governance/example.mdx', afterSha256: createHash('sha256').update('next').digest('hex') }],
}) }));
vi.mock('../../../../src/api/capacity/services/treedx/repositories/treedx-authoring-journal.ts', () => ({ recordTreeDxAuthoringState: vi.fn() }));
vi.mock('../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts', () => ({ projectTreeDxCommitSignals: vi.fn() }));

function fixture(mode = 'simulation') {
	const base = 'a'.repeat(40), path = 'proposals/governance/example.mdx';
	const run = { id: 'workday-1', status: 'running', executionMode: mode, parameters: {
		appliedPlan: { state: 'active', endsAt: '2099-01-01T00:00:00.000Z' }, scheduledProjectIds: ['project-1'], proposalIds: ['proposal-1'],
	} };
	vi.spyOn(CapacityWorkdayRunRepository.prototype, 'get').mockResolvedValue(run as never);
	const client = { createWorkspace: vi.fn(async () => ({ workspaceId: 'workspace-1', baseCommitSha: base })),
		readRepositoryFiles: vi.fn(async () => ({ resolvedRef: base, files: [{ path: '.treeseed/governance/proposal-types/implementation.yaml', content: JSON.stringify({
			schemaVersion: 'treeseed.proposal-type/v1', id: 'implementation', label: 'Implementation', description: 'Bounded change.',
		}) }] })), readRepositoryFile: vi.fn(async () => ({ resolvedRef: base, file: { content: 'before' } })),
		closeWorkspace: vi.fn(async () => undefined), commit: vi.fn(async () => ({ commitSha: 'b'.repeat(40), branchName: mode === 'simulation' ? 'refs/heads/workday-1' : 'refs/heads/staging', changedPaths: [path] })) };
	vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ client, contentPath: '.', repositoryId: 'repository-1', authoringBranch: 'staging', allowedPaths: ['proposals/**'] } as never);
	const input = { store: {}, principal: { id: 'user-1' }, proposal: { id: 'proposal-1', teamId: 'team-1', projectId: 'project-1', activeVersion: 4,
		title: 'Example', proposalTypes: ['implementation'], metadata: { contentProvenance: { contentPath: path, commitSha: base } } }, update: { workdayId: run.id } };
	return { run, client, input, base, path };
}

describe('workday-scoped proposal authoring', () => {
	beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
	it('writes a simulation version from exact provenance to local workday custody without publication', async () => {
		const { input, client, base, path } = fixture();
		const result = await commitProposalVersionContent(input);
		const proposalBranch = `refs/heads/workday-1-proposal-${createHash('sha256').update('proposal-1').digest('hex').slice(0, 16)}`;
		expect(client.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ baseRef: base, branchName: proposalBranch, allowedPaths: [path] }));
		expect(client.readRepositoryFiles).toHaveBeenCalledWith(expect.objectContaining({ ref: base }));
		expect(result.update.contentProvenance).toMatchObject({ commitSha: 'b'.repeat(40), contentPath: path });
		expect(recordTreeDxAuthoringState).not.toHaveBeenCalled(); expect(projectTreeDxCommitSignals).not.toHaveBeenCalled();
		expect(client.closeWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1');
	});
	it('does not reuse an advanced discussion branch that lacks the proposal source', async () => {
		const { input, client, base } = fixture();
		client.createWorkspace.mockImplementationOnce(async request => {
			if (request.branchName === 'refs/heads/workday-1' && request.baseRef === base) {
				throw new Error('Workspace branch already exists at a different commit.');
			}
			return { workspaceId: 'workspace-1', baseCommitSha: base };
		});
		await expect(commitProposalVersionContent(input)).resolves.toMatchObject({ update: { contentProvenance: { commitSha: 'b'.repeat(40) } } });
		expect(client.createWorkspace.mock.calls[0]?.[0].branchName).not.toBe('refs/heads/workday-1');
	});
	it('starts a later estimate version from its exact prior proposal commit on the same simulation branch', async () => {
		const { input, client } = fixture();
		input.proposal.metadata.contentProvenance.commitSha = 'b'.repeat(40);
		const first = await commitProposalVersionContent(input);
		const second = await commitProposalVersionContent(input);
		expect(client.createWorkspace).toHaveBeenCalledTimes(2);
		expect(client.createWorkspace.mock.calls[0]?.[0].branchName).toBe(client.createWorkspace.mock.calls[1]?.[0].branchName);
		expect(client.createWorkspace.mock.calls[1]?.[0].baseRef).toBe('b'.repeat(40));
		expect(first.update.contentProvenance.commitSha).toBe(second.update.contentProvenance.commitSha);
	});
	it.each(['missing', 'terminal', 'project', 'proposal', 'expired'])('rejects %s workday scope before issuing a workspace', async invalid => {
		const { run, input, client } = fixture();
		if (invalid === 'missing') vi.mocked(CapacityWorkdayRunRepository.prototype.get).mockResolvedValue(null);
		if (invalid === 'terminal') run.status = 'completed';
		if (invalid === 'project') run.parameters.scheduledProjectIds = ['other'];
		if (invalid === 'proposal') run.parameters.proposalIds = ['other'];
		if (invalid === 'expired') run.parameters.appliedPlan.endsAt = '2000-01-01T00:00:00.000Z';
		await expect(commitProposalVersionContent(input)).rejects.toMatchObject({ code: 'proposal_workday_scope_invalid' });
		expect(client.createWorkspace).not.toHaveBeenCalled(); expect(client.commit).not.toHaveBeenCalled();
	});
	it.each(['', {}, null])('does not fall back to publication for malformed workday scope (%j)', async workdayId => {
		const { input, client } = fixture();
		await expect(commitProposalVersionContent({ ...input, update: { workdayId } })).rejects.toMatchObject({ code: 'proposal_workday_id_invalid' });
		expect(client.createWorkspace).not.toHaveBeenCalled();
	});
	it('rejects simulation authoring without an exact base before creating a workspace', async () => {
		const { input, client } = fixture(); input.proposal.metadata.contentProvenance.commitSha = 'staging';
		await expect(commitProposalVersionContent(input)).rejects.toMatchObject({ code: 'proposal_simulation_source_required' });
		expect(client.createWorkspace).not.toHaveBeenCalled();
	});
	it('retains the ordinary production authoring and replication path', async () => {
		const { input, client } = fixture('production'); await commitProposalVersionContent(input);
		expect(client.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ baseRef: 'refs/heads/staging', branchName: 'refs/heads/staging' }));
		expect(recordTreeDxAuthoringState).toHaveBeenCalledOnce(); expect(projectTreeDxCommitSignals).toHaveBeenCalledOnce();
	});
});
