import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ readRepositoryFile: vi.fn() }));
vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
	resolveKnowledgeGatewayConnection: vi.fn(async () => ({ repositoryId: 'repository', client })),
}));

import { readExactProposal } from '../../../../src/api/governance/executable-proposal.ts';

describe('exact executable proposal custody', () => {
	beforeEach(() => client.readRepositoryFile.mockReset());

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
});
