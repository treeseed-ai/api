import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolve } = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../../../../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
	resolveKnowledgeGatewayConnection: resolve,
}));
import { loadTeamExactDependencyLinks } from '../../../../../../../src/api/capacity/services/capacity/execution/exact-dependency-links.ts';

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

beforeEach(() => { resolve.mockReset(); });

describe('exact TreeDX dependency intake', () => {
	it('requires a scoped grant, exact graph commit, and matching note bytes', async () => {
		const client = { queryGraph: vi.fn(async () => graph),
			readRepositoryFile: vi.fn(async () => ({ resolvedRef: 'c'.repeat(40),
				file: { content: 'content', frontmatter: note } })) };
		resolve.mockImplementation(async (_store, input) => ({ repositoryId: `${input.projectId}-library`,
			publicationRef: 'refs/heads/staging', allowedPaths: ['proposals/**', 'notes/**'], client: input.projectId === 'sdk' ? client : {
				queryGraph: async () => ({ resolvedRef: 'd'.repeat(40), nodes: [], edges: [] }) } }));
		const result = await loadTeamExactDependencyLinks({}, [sdk, api] as never);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ from: link.from, to: link.to,
			sourceRef: { model: 'note', repository: 'sdk-library', commit: 'c'.repeat(40), path: 'notes/dependency.md' } });
		expect(client.readRepositoryFile).toHaveBeenCalledWith(expect.objectContaining({ ref: 'c'.repeat(40) }));
		expect(resolve).toHaveBeenCalledWith({}, expect.objectContaining({ projectId: 'sdk', readRefs: ['c'.repeat(40)] }));
		expect(resolve).toHaveBeenCalledWith({}, expect.objectContaining({ projectId: 'api', readRefs: ['a'.repeat(40)] }));
		expect(client.queryGraph).toHaveBeenCalledWith(expect.objectContaining({ relations: ['depends_on'],
			seeds: [{ kind: 'type', value: 'ExactEntityReference' }] }));
	});

	it('rejects a moved note snapshot', async () => {
		resolve.mockResolvedValue({ repositoryId: 'sdk-library', publicationRef: 'refs/heads/staging',
			client: { queryGraph: async () => graph,
				readRepositoryFile: async () => ({ resolvedRef: 'd'.repeat(40), file: { content: 'content', frontmatter: note } }) } });
		await expect(loadTeamExactDependencyLinks({}, [sdk, api] as never)).rejects.toThrow('moved during read');
	});

	it('fails closed when the pinned commit is not in the read grant', async () => {
		resolve.mockResolvedValueOnce({ repositoryId: 'sdk-library', publicationRef: 'refs/heads/staging',
			client: { queryGraph: async () => graph } }).mockResolvedValueOnce(null);
		await expect(loadTeamExactDependencyLinks({}, [sdk, api] as never)).rejects.toThrow('exact dependency read grant is missing');
	});

	it('rejects a cross-project relation without a path-scoped endpoint grant', async () => {
		resolve.mockImplementation(async (_store, input) => ({ repositoryId: `${input.projectId}-library`,
			publicationRef: 'refs/heads/staging', allowedPaths: input.projectId === 'api' ? ['knowledge/**'] : ['proposals/**', 'notes/**'],
			client: { queryGraph: async () => graph,
				readRepositoryFile: async () => ({ resolvedRef: 'c'.repeat(40), file: { content: 'content', frontmatter: note } }) } }));
		await expect(loadTeamExactDependencyLinks({}, [sdk, api] as never)).rejects.toThrow('endpoint read grant is missing for project api');
	});
});
