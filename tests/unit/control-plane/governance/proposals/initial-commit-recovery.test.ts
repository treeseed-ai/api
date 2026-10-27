import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitProposalVersionContent } from '../../../../../src/api/control-plane/governance/proposal-version-content.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';
import { projectTreeDxCommitSignals } from '../../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts';
import { serializeProposalDocument } from '../../../../../src/api/governance/proposal-document.ts';
import { createGovernanceService } from '../../../../../src/api/control-plane/governance/governance-service.ts';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', async original => ({
	...await original<typeof import('../../../../../src/api/knowledge/gateway-treedx-connection.ts')>(), resolveKnowledgeGatewayConnection: vi.fn(),
}));
vi.mock('../../../../../src/api/capacity/services/treedx/repositories/treedx-authoring-journal.ts', () => ({ recordTreeDxAuthoringState: vi.fn() }));
vi.mock('../../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts', () => ({ projectTreeDxCommitSignals: vi.fn() }));

function fixture(existing = false) {
	const base = 'a'.repeat(40), commit = 'b'.repeat(40), path = 'proposals/governance/compose-workloads.mdx';
	const definition = { id: 'proposal-1', projectId: 'project-1', title: 'Compose workloads', request: 'Run the actual project stack.',
		status: 'draft' as const, groupIds: ['project-agent'] };
	const source = serializeProposalDocument(definition), digest = createHash('sha256').update(source).digest('hex');
	const client = { createWorkspace: vi.fn(async () => ({ workspaceId: 'workspace-1', baseCommitSha: base })),
		readRepositoryFiles: vi.fn(async () => ({ resolvedRef: base, files: [{ path: '.treeseed/governance/proposal-types/implementation.yaml',
			content: JSON.stringify({ schemaVersion: 'treeseed.proposal-type/v1', id: 'implementation', label: 'Implementation', description: 'Bounded work.' }) }] })),
		readRepositoryFile: vi.fn(async () => { if (!existing) throw Object.assign(new Error('Missing'), { status: 404 });
			return { resolvedRef: base, file: { content: source } }; }),
		applyChangeset: vi.fn(async () => ({ files: [{ path, afterSha256: digest }] })),
		commit: vi.fn(async () => ({ commitSha: commit, branchName: 'refs/heads/staging', changedPaths: [path] })),
		closeWorkspace: vi.fn(async () => undefined) };
	vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ client, repositoryId: 'repository-1', contentPath: '.',
		baseRef: base, authoringBranch: 'staging', allowedPaths: ['proposals/**'] } as never);
	const input = { store: {}, principal: { id: 'user-1' }, initial: true,
		proposal: { id: definition.id, projectId: definition.projectId, teamId: 'team-1', title: definition.title,
			body: definition.request, proposalTypes: ['implementation'] }, update: { groupIds: definition.groupIds } };
	return { input, client, commit, path, source, digest, base };
}

function serviceFixture() {
	const f = fixture();
	let retained: Record<string, unknown> | null = null;
	const store = { getProjectDetails: async () => ({ project: { id: 'project-1', teamId: 'team-1' } }),
		createGovernanceProposal: async () => (retained = { ...f.input.proposal, activeVersion: 1, activeContentHash: 'initial', metadata: {} }),
		getGovernanceProposal: async () => retained,
		batch: async (statements: Array<{ query: string; params: unknown[] }>) => {
			for (const statement of statements) {
				if (statement.query.startsWith('DELETE FROM governance_proposals ')) retained = null;
				if (statement.query.startsWith('UPDATE governance_proposals ') && retained) {
					retained.metadata = JSON.parse(String(statement.params[5])); retained.activeContentHash = statement.params[6];
				}
			}
		} };
	return { ...f, retained: () => retained, service: createGovernanceService(store, { create: vi.fn() }) };
}

describe('initial proposal commit recovery', () => {
	beforeEach(() => vi.clearAllMocks());
	it('retains the exact authored receipt when graph projection fails after committing', async () => {
		const f = fixture(), conflict = Object.assign(new Error('The execution graph changed concurrently.'), { code: 'execution_graph_revision_conflict', status: 409 });
		vi.mocked(projectTreeDxCommitSignals).mockRejectedValueOnce(conflict);
		await expect(commitProposalVersionContent(f.input)).rejects.toMatchObject({ cause: conflict, code: conflict.code, status: conflict.status,
			authored: { receipt: { path: f.path, commitSha: f.commit, digest: f.digest },
				update: { contentProvenance: { repositoryId: 'repository-1', contentPath: f.path, commitSha: f.commit, digest: f.digest } } } });
		expect(f.client.commit).toHaveBeenCalledOnce();
		expect(f.client.closeWorkspace).toHaveBeenCalledWith('workspace-1');
	});
	it('recovers identical initial bytes without another changeset or commit', async () => {
		const f = fixture(true), result = await commitProposalVersionContent(f.input);
		expect(result.receipt).toMatchObject({ commitSha: f.base, digest: f.digest, changedPaths: [] });
		expect(result.update.contentProvenance).toMatchObject({ commitSha: f.base, digest: f.digest });
		expect(f.client.applyChangeset).not.toHaveBeenCalled(); expect(f.client.commit).not.toHaveBeenCalled();
		expect(f.client.closeWorkspace).toHaveBeenCalledOnce();
	});
	it('keeps the public proposal discoverable and bound after committed projection failure', async () => {
		const f = serviceFixture();
		vi.mocked(projectTreeDxCommitSignals).mockRejectedValueOnce(new Error('Graph reconciliation interrupted'));
		await expect(f.service.createProposal({ id: 'user-1', roles: ['admin'] }, 'project-1', {
			...f.input.proposal, groupIds: f.input.update.groupIds })).rejects.toMatchObject({
			code: 'proposal_initial_projection_pending', message: expect.stringContaining(f.commit) });
		expect(f.retained()).toMatchObject({ id: 'proposal-1', activeContentHash: f.digest,
			metadata: { contentProvenance: { repositoryId: 'repository-1', commitSha: f.commit, digest: f.digest } } });
	});
	it('removes only the uncommitted proposal when source access is denied', async () => {
		const f = serviceFixture();
		f.client.readRepositoryFile.mockRejectedValueOnce(Object.assign(new Error('Source denied'), { status: 403 }));
		await expect(f.service.createProposal({ id: 'user-1', roles: ['admin'] }, 'project-1', f.input.proposal)).rejects.toMatchObject({ status: 403 });
		expect(f.retained()).toBeNull(); expect(f.client.commit).not.toHaveBeenCalled();
	});
	it.each(['foreign-id', 'different-request'])('keeps occupied source immutable for %s', async kind => {
		const f = fixture(true);
		const input = { ...f.input, proposal: { ...f.input.proposal,
			...(kind === 'foreign-id' ? { id: 'proposal-2' } : { body: 'Different proposed work.' }) } };
		await expect(commitProposalVersionContent(input)).rejects.toMatchObject({ code: 'proposal_source_path_occupied', status: 409,
			message: expect.stringContaining('proposal-1') });
		expect(f.client.applyChangeset).not.toHaveBeenCalled(); expect(f.client.commit).not.toHaveBeenCalled();
		expect(f.client.closeWorkspace).toHaveBeenCalledOnce();
	});
});
