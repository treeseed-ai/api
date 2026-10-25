import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolve } = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../../../../../../../src/api/knowledge/gateway-treedx-connection.ts', async (original) => ({
	...await original<typeof import('../../../../../../../src/api/knowledge/gateway-treedx-connection.ts')>(),
	resolveKnowledgeGatewayConnection: resolve,
}));
import { loadTeamExactDependencyLinks } from '../../../../../../../src/api/capacity/services/capacity/execution/exact-dependency-links.ts';
import { stringify } from 'yaml';
import { createHash } from 'node:crypto';

const proposal = (id: string) => ({ teamId: 'team', projectId: id, repository: `${id}-library`,
	path: `proposals/${id}.md`, commit: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}`,
	proposalRevision: 1, frontmatter: { id }, decision: null });
const sdk = proposal('sdk'), api = proposal('api');
const endpoint = (source: typeof sdk, anchor: string) => ({ store: 'treedx', model: 'proposal',
	id: source.frontmatter.id, revision: 1, repository: source.repository, commit: source.commit,
	path: source.path, digest: source.digest, anchor });
const link = { relation: 'depends_on', from: endpoint(sdk, 'work-item/simulate-release'),
	to: endpoint(api, 'work-item/tests-first') };
const graph = { resolvedRef: 'c'.repeat(40), nodes: [
	{ node: { id: 'ref-from', nodeType: 'Reference', entityType: 'ExactEntityReference', ownerFileId: 'note-file', data: link.from } },
	{ node: { id: 'ref-to', nodeType: 'Reference', entityType: 'ExactEntityReference', ownerFileId: 'note-file', data: link.to } },
], edges: [{ type: 'DEPENDS_ON', sourceId: 'ref-from', targetId: 'ref-to', ownerFileId: 'note-file',
	data: { link, ownerPath: 'notes/dependency.md' } }] };
const note = { schemaVersion: 'treeseed.note/v1', id: 'dependency', projectId: 'sdk',
	classification: 'general', subjectRefs: [link.from, link.to], body: 'API follows the SDK candidate.',
	createdAt: '2026-09-20T00:00:00Z', links: [link] };
const noteBytes = `---\n${stringify(note)}---\n\n${note.body}\n`;

beforeEach(() => { resolve.mockReset(); });

describe('exact TreeDX dependency intake', () => {
	it('rebuilds only an unready exact snapshot through a scoped refresh grant before reading its links', async () => {
		const notReady = Object.assign(new Error('Graph is not ready.'), { code: 'graph_not_ready' });
		const client = { listRepositoryPaths: vi.fn(async () => ({ resolvedRef: graph.resolvedRef })),
			queryGraph: vi.fn().mockRejectedValueOnce(notReady).mockResolvedValue(graph),
			refreshGraph: vi.fn(async () => ({ graph: { jobId: 'exact-refresh', resolvedRef: graph.resolvedRef } })),
			getGraphRefreshJob: vi.fn(async () => ({ job: { status: 'completed', graphVersion: 'exact-index' } })),
			readRepositoryFile: vi.fn(async () => ({ resolvedRef: graph.resolvedRef,
				file: { path: 'notes/dependency.md', content: noteBytes, frontmatter: note } })) };
		resolve.mockImplementation(async (_store, input) => ({ repositoryId: `${input.projectId}-library`, contentPath: '.',
			baseRef: 'staging', allowedPaths: ['notes/**', 'proposals/**'], client: input.projectId === 'sdk' ? client : {
				listRepositoryPaths: async () => ({ resolvedRef: 'd'.repeat(40) }),
				queryGraph: async () => ({ resolvedRef: 'd'.repeat(40), nodes: [], edges: [] }) } }));
		expect(await loadTeamExactDependencyLinks({}, [sdk, api] as never)).toHaveLength(1);
		expect(resolve).toHaveBeenCalledWith({}, { projectId: 'sdk', write: false, relationPaths: true,
			readRefs: [graph.resolvedRef], refreshGraph: true });
		expect(client.refreshGraph).toHaveBeenCalledWith({ repoId: 'sdk-library', ref: graph.resolvedRef,
			paths: ['notes/**', 'proposals/**'] });
		expect(client.getGraphRefreshJob).toHaveBeenCalledWith({ repoId: 'sdk-library', ref: graph.resolvedRef, jobId: 'exact-refresh' });
		expect(client.queryGraph).toHaveBeenCalledTimes(2);
		expect(client.queryGraph.mock.calls[0]).toEqual(client.queryGraph.mock.calls[1]);
	});

	it.each(['permission_denied', 'authentication_required', 'transport_failed'])('does not reinterpret %s as an empty or unready dependency graph', async (code) => {
		const error = Object.assign(new Error(code), { code });
		resolve.mockResolvedValue({ repositoryId: 'sdk-library', contentPath: '.', baseRef: 'staging', allowedPaths: ['notes/**'],
			client: { listRepositoryPaths: async () => ({ resolvedRef: graph.resolvedRef }), queryGraph: async () => { throw error; } } });
		await expect(loadTeamExactDependencyLinks({}, [sdk, api] as never)).rejects.toBe(error);
		expect(resolve.mock.calls.some(([, input]) => input.refreshGraph)).toBe(false);
	});
	it.each(['missing-grant', 'wrong-repository', 'failed-job', 'still-unready'])('retains the dependency failure after %s', async (failure) => {
		const notReady = Object.assign(new Error('Graph is not ready.'), { code: 'graph_not_ready' });
		const client = { listRepositoryPaths: async () => ({ resolvedRef: graph.resolvedRef }),
			queryGraph: vi.fn(async () => { throw notReady; }),
			refreshGraph: vi.fn(async () => ({ graph: { jobId: 'exact-refresh' } })),
			getGraphRefreshJob: vi.fn(async () => ({ job: { status: failure === 'failed-job' ? 'failed' : 'completed', errorCode: 'native-index-failed' } })) };
		resolve.mockImplementation(async (_store, input) => input.refreshGraph && failure === 'missing-grant' ? null : {
			repositoryId: input.refreshGraph && failure === 'wrong-repository' ? 'foreign-library' : 'sdk-library',
			contentPath: '.', baseRef: 'staging', allowedPaths: ['notes/**'], client });
		await expect(loadTeamExactDependencyLinks({}, [sdk, api] as never)).rejects.toThrow(
			failure === 'failed-job' ? 'native-index-failed' : failure === 'still-unready' ? 'Graph is not ready.' : 'refresh grant is missing');
		expect(client.queryGraph).toHaveBeenCalledTimes(failure === 'still-unready' ? 2 : 1);
		if (failure === 'missing-grant' || failure === 'wrong-repository') expect(client.refreshGraph).not.toHaveBeenCalled();
	});

	it('requires a scoped grant, exact graph commit, and matching note bytes', async () => {
		const client = { listRepositoryPaths: vi.fn(async () => ({ resolvedRef: 'c'.repeat(40) })), queryGraph: vi.fn(async () => graph),
			readRepositoryFile: vi.fn(async () => ({ resolvedRef: 'c'.repeat(40),
				file: { path: 'notes/dependency.md', content: noteBytes, frontmatter: note } })) };
		resolve.mockImplementation(async (_store, input) => ({ repositoryId: `${input.projectId}-library`,
			contentPath: '.', baseRef: 'refs/remotes/origin/staging', allowedPaths: ['proposals/**', 'notes/**'], client: input.projectId === 'sdk' ? client : {
				listRepositoryPaths: async () => ({ resolvedRef: 'd'.repeat(40) }), queryGraph: async () => ({ resolvedRef: 'd'.repeat(40), nodes: [], edges: [] }) } }));
		const result = await loadTeamExactDependencyLinks({}, [sdk, api] as never);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ from: link.from, to: link.to,
			sourceRef: { model: 'note', repository: 'sdk-library', commit: 'c'.repeat(40), path: 'notes/dependency.md',
				digest: `sha256:${createHash('sha256').update(noteBytes).digest('hex')}` } });
		expect(client.readRepositoryFile).toHaveBeenCalledWith(expect.objectContaining({ ref: 'c'.repeat(40) }));
		expect(resolve).toHaveBeenCalledWith({}, expect.objectContaining({ projectId: 'sdk', readRefs: ['c'.repeat(40)] }));
		expect(resolve).toHaveBeenCalledWith({}, expect.objectContaining({ projectId: 'api', readRefs: ['a'.repeat(40)] }));
		expect(client.queryGraph).toHaveBeenCalledWith(expect.objectContaining({ ref: 'c'.repeat(40), relations: ['depends_on'],
			seeds: [{ kind: 'type', value: 'ExactEntityReference' }] }));
	});

	it('rejects a moved note snapshot', async () => {
		resolve.mockImplementation(async (_store, input) => ({ repositoryId: `${input.projectId}-library`, contentPath: '.', baseRef: 'refs/remotes/origin/staging', allowedPaths: ['proposals/**', 'notes/**'],
			client: { listRepositoryPaths: async () => ({ resolvedRef: 'c'.repeat(40) }), queryGraph: async () => graph,
				readRepositoryFile: async () => ({ resolvedRef: 'd'.repeat(40), file: { content: 'content', frontmatter: note } }) } }));
		await expect(loadTeamExactDependencyLinks({}, [sdk, api] as never)).rejects.toThrow('moved during read');
	});

	it('fails closed when the pinned commit is not in the read grant', async () => {
		resolve.mockResolvedValueOnce({ repositoryId: 'sdk-library', contentPath: '.', baseRef: 'refs/remotes/origin/staging',
			client: { listRepositoryPaths: async () => ({ resolvedRef: 'c'.repeat(40) }), queryGraph: async () => graph } }).mockResolvedValueOnce(null);
		await expect(loadTeamExactDependencyLinks({}, [sdk, api] as never)).rejects.toThrow('exact dependency read grant is missing');
	});

	it('rejects a cross-project relation without a path-scoped endpoint grant', async () => {
		resolve.mockImplementation(async (_store, input) => ({ repositoryId: `${input.projectId}-library`,
			contentPath: '.', baseRef: 'refs/remotes/origin/staging', allowedPaths: input.projectId === 'api' ? ['knowledge/**'] : ['proposals/**', 'notes/**'],
			client: { listRepositoryPaths: async () => ({ resolvedRef: 'c'.repeat(40) }), queryGraph: async () => graph,
				readRepositoryFile: async () => ({ resolvedRef: 'c'.repeat(40), file: { content: 'content', frontmatter: note } }) } }));
		await expect(loadTeamExactDependencyLinks({}, [sdk, api] as never)).rejects.toThrow('endpoint read grant is missing for project api');
	});
});
