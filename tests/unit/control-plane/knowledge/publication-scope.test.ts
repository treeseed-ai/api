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
				refreshGraph: vi.fn(async (_input: { ref: string }) => ({ resolvedRef: commit, graphVersion: 'graph' })),
				refreshSearchIndex: vi.fn(async (_input: { ref: string }) => ({ resolvedRef: commit, stale: false })),
			};
			const load = vi.fn(async () => { throw new Error('snapshot-boundary'); });
			const resolveConnection = vi.fn(async (_store: unknown, _input: Record<string, unknown>) => ({ client, publicationRef: ref, repositoryId: 'repo' }));
			const executor = createKnowledgePublicationExecutor({ environment: 'local', controlPlaneStore: store,
				knowledgePublicationStorage: { readCurrent: async () => previous }, loadKnowledgeSnapshotProjects: load,
				resolveKnowledgeGatewayConnection: resolveConnection });
			await expect(executor.run({ publicationId: 'publication' }, { operation: { id: 'operation' }, checkpoint: vi.fn() }))
				.rejects.toThrow('snapshot-boundary');
			expect(load).toHaveBeenCalledWith(store, { teamId: 'team', projectIds: new Set(['admin']),
				projectRefs: new Map([['admin', commit]]) });
			expect(client.refreshGraph).toHaveBeenCalledWith(expect.objectContaining({ ref: commit }));
			expect(client.refreshSearchIndex).toHaveBeenCalledWith(expect.objectContaining({ ref: commit }));
			// The dependency consumer reads the published branch. Exact-commit
			// indexing alone must not report that branch ready for scheduling.
			expect(client.refreshGraph.mock.calls.map(([input]) => input)).toEqual([
				expect.objectContaining({ ref: commit }), expect.objectContaining({ ref }),
			]);
			expect(client.refreshSearchIndex.mock.calls.map(([input]) => input)).toEqual([
				expect.objectContaining({ ref: commit }), expect.objectContaining({ ref }),
			]);
			expect(resolveConnection).toHaveBeenCalledWith(store, {
				projectId: workspace.projectId, write: false, authoringPaths: true,
				publishRefs: [workspace.branchName, ref, commit, `refs/treedx/commits/${commit}`],
			});
		});
	it('denies moved stale and failed published branch indexes before manifest publication while retaining exact commit indexing and supplied authority', async () => {
		for (const failure of ['graph-moved', 'search-moved', 'search-stale', 'graph-failed', 'search-failed']) {
			const commit = 'a'.repeat(40), ref = 'refs/heads/staging', cause = new Error(`native ${failure}`);
			const publication = { id: 'publication', status: 'queued', commit_sha: commit, published_ref: ref };
			const workspace = { id: 'workspace', status: 'approved', projectId: 'admin', teamId: 'team',
				repositoryId: 'repo', branchName: 'review', baseCommitSha: 'b'.repeat(40), allowedPaths: ['notes/**'] };
			const review = { status: 'approved', commitSha: commit }, before = structuredClone({ publication, workspace, review });
			const store = { first: async (sql: string) => sql.includes('knowledge_publications') ? publication : null,
				getKnowledgeWorkspace: async () => workspace, getKnowledgeReview: async () => review };
			const client = { getRepository: async () => ({ storageKind: 'managed' }), promoteRef: async () => ({}),
				refreshGraph: vi.fn(async (input: { ref: string }) => {
					if (input.ref === ref && failure === 'graph-failed') throw cause;
					return { resolvedRef: input.ref === ref && failure === 'graph-moved' ? 'c'.repeat(40) : commit, graphVersion: 'graph' };
				}), refreshSearchIndex: vi.fn(async (input: { ref: string }) => {
					if (input.ref === ref && failure === 'search-failed') throw cause;
					return { resolvedRef: input.ref === ref && failure === 'search-moved' ? 'c'.repeat(40) : commit,
						stale: input.ref === ref && failure === 'search-stale' };
				}) };
			const load = vi.fn(async () => { throw new Error('must not consume failed branch'); });
			const publish = vi.fn(async () => { throw new Error('must not publish failed branch'); });
			const executor = createKnowledgePublicationExecutor({ environment: 'local', controlPlaneStore: store,
				knowledgePublicationStorage: { readCurrent: async () => null, publish }, loadKnowledgeSnapshotProjects: load,
				resolveKnowledgeGatewayConnection: async () => ({ client, publicationRef: ref, repositoryId: 'repo' }) });
			const result = executor.run({ publicationId: publication.id }, { operation: { id: 'operation' }, checkpoint: async () => {} });
			if (failure.endsWith('-failed')) await expect(result).rejects.toBe(cause);
			else await expect(result).rejects.toMatchObject({ code: 'treedx_source_closure_stale' });
			expect(client.refreshGraph).toHaveBeenCalledWith(expect.objectContaining({ ref: commit }));
			expect(client.refreshSearchIndex).toHaveBeenCalledWith(expect.objectContaining({ ref: commit }));
			expect(load).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
			expect({ publication, workspace, review }).toEqual(before);
		}
	});
});
