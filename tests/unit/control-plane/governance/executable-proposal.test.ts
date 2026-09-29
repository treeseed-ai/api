import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ readRepositoryFile: vi.fn() }));
vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
	resolveKnowledgeGatewayConnection: vi.fn(async () => ({ repositoryId: 'repository', client })),
}));

import { proposalApprovalFingerprint, readExactProposal } from '../../../../src/api/governance/executable-proposal.ts';

describe('exact executable proposal custody', () => {
	beforeEach(() => client.readRepositoryFile.mockReset());
	it('preserves early approval across estimates but not objective or dependency changes', () => {
		const draft = { id: 'proposal', status: 'draft', request: 'Implement the contract.', executionPlan: {
			workItems: [{ id: 'implementation', objective: 'Ship the contract.', dependsOn: [] }],
		} };
		const approved = proposalApprovalFingerprint(draft);
		expect(proposalApprovalFingerprint({ ...draft, status: 'ready', executionPlan: {
			workItems: [{ ...draft.executionPlan.workItems[0], estimate: { expectedSeconds: 30, maximumSeconds: 60 } }],
		} })).toBe(approved);
		expect(proposalApprovalFingerprint({ ...draft, request: 'Ship a different contract.' })).not.toBe(approved);
		expect(proposalApprovalFingerprint({ ...draft, executionPlan: {
			workItems: [{ ...draft.executionPlan.workItems[0], dependsOn: ['other'] }],
		} })).not.toBe(approved);
	});

	it('hashes the exact source bytes including the terminal newline', async () => {
		const source = '---\nschemaVersion: treeseed.proposal/v1\nid: proposal\nprojectId: project\ntitle: Exact source\nrequest: Preserve the exact proposal bytes.\nstatus: draft\n---\n';
		const digest = createHash('sha256').update(source).digest('hex');
		client.readRepositoryFile.mockResolvedValue({ resolvedRef: 'a'.repeat(40), file: { content: source, frontmatter: {
			schemaVersion: 'treeseed.proposal/v1', id: 'proposal', projectId: 'project', title: 'Exact source',
			request: 'Preserve the exact proposal bytes.', status: 'draft',
		} } });
		await expect(readExactProposal({}, { id: 'proposal', projectId: 'project', activeVersion: 1, activeContentHash: digest,
			metadata: { contentProvenance: { repositoryId: 'repository', contentPath: 'proposals/proposal.mdx', commitSha: 'a'.repeat(40), digest } } }))
			.resolves.toMatchObject({ source, ref: { digest: `sha256:${digest}`, commit: 'a'.repeat(40) } });
	});
	it('keeps planning source immutable when genuine estimates advance the governed proposal', async () => {
		const source = 'Frozen planning input.\n', digest = createHash('sha256').update(source).digest('hex');
		client.readRepositoryFile.mockResolvedValue({ resolvedRef: 'a'.repeat(40), file: { content: source, frontmatter: {
			schemaVersion: 'treeseed.proposal/v1', id: 'proposal', projectId: 'project', title: 'Exact source',
			request: 'Preserve the exact proposal bytes.', status: 'draft',
		} } });
		const frozen = { store: 'treedx' as const, model: 'proposal', id: 'proposal', revision: 1,
			digest: `sha256:${digest}`, repository: 'repository', path: 'proposals/proposal.mdx', commit: 'a'.repeat(40) };
		await expect(readExactProposal({}, { id: 'proposal', projectId: 'project', activeVersion: 2,
			activeContentHash: 'b'.repeat(64), metadata: { contentProvenance: { commitSha: 'b'.repeat(40) } } }, frozen))
			.resolves.toMatchObject({ source, ref: frozen });
		expect(client.readRepositoryFile).toHaveBeenCalledWith(expect.objectContaining({ ref: frozen.commit }));
		await expect(readExactProposal({}, { id: 'other', projectId: 'project' }, frozen))
			.rejects.toMatchObject({ code: 'proposal_identity_mismatch' });
	});
});
