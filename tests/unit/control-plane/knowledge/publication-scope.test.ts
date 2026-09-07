import { describe, expect, it, vi } from 'vitest';
import { createKnowledgePublicationExecutor } from '../../../../src/operations-runner/knowledge/publication-executor.ts';

describe('reviewed publication source scope', () => {
	it.each([null, { revision: 'previous', projects: [{ projectId: 'other', commitSha: 'older' }] }])(
		'snapshots only the reviewed project, with prior manifest %j', async previous => {
			const commit = 'a'.repeat(40), ref = 'refs/heads/staging';
			const publication = { id: 'publication', status: 'queued', commit_sha: commit, published_ref: ref };
			const workspace = { id: 'workspace', status: 'approved', projectId: 'admin', teamId: 'team',
				repositoryId: 'repo', branchName: 'review', baseCommitSha: 'b'.repeat(40), allowedPaths: ['knowledge/**'] };
			const store = {
				first: vi.fn(async (sql: string) => sql.includes('knowledge_publications') ? publication : null),
				getKnowledgeWorkspace: vi.fn(async () => workspace),
				getKnowledgeReview: vi.fn(async () => ({ status: 'approved', commitSha: commit })),
				listTeamProjects: vi.fn(async () => [{ id: 'admin' }, { id: 'unconfigured-scratch' }]),
			};
			const client = {
				getRepository: vi.fn(async () => ({ storageKind: 'managed' })),
				promoteRef: vi.fn(async () => ({})),
				refreshGraph: vi.fn(async () => ({ resolvedRef: commit, graphVersion: 'graph' })),
				refreshSearchIndex: vi.fn(async () => ({ resolvedRef: commit, stale: false })),
			};
			const load = vi.fn(async () => { throw new Error('snapshot-boundary'); });
			const executor = createKnowledgePublicationExecutor({ environment: 'local', controlPlaneStore: store,
				knowledgePublicationStorage: { readCurrent: async () => previous }, loadKnowledgeSnapshotProjects: load,
				resolveKnowledgeGatewayConnection: async () => ({ client, publicationRef: ref, repositoryId: 'repo' }) });
			await expect(executor.run({ publicationId: 'publication' }, { operation: { id: 'operation' }, checkpoint: vi.fn() }))
				.rejects.toThrow('snapshot-boundary');
			expect(load).toHaveBeenCalledWith(store, { teamId: 'team', projectIds: new Set(['admin']),
				projectRefs: new Map([['admin', commit]]) });
		});
});
