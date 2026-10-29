import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { executionNodeSchema } from '@treeseed/sdk/agent-capacity';
import { workItemContext } from '../../../../../../../src/api/capacity/services/build/ready-execution-node.ts';
import { candidate } from '../../fixtures/assignment-attempt-fixtures.ts';
import { resolveAuthorizedSourceCommit } from '../../../../../../../src/api/control-plane/repositories/providers/source/source-pin.ts';
import { workdayObjectiveContext } from '../../../../../../../src/api/capacity/services/capacity/assignments/context/workday-objective-context.ts';

const gateway = vi.hoisted(() => ({ repositoryId: 'library', queryRepository: vi.fn(), readRepositoryFile: vi.fn() }));
vi.mock('../../../../../../../src/api/knowledge/gateway-treedx-connection.ts', async original => ({
	...await original<object>(),
	resolveKnowledgeGatewayConnection: vi.fn(async () => ({ repositoryId: gateway.repositoryId, contentPath: '.', client: gateway })),
}));

vi.mock('../../../../../../../src/security/provider-credential-authority.ts', () => ({
	resolveGitHubSourceAuthority: vi.fn(async () => null),
}));
vi.mock('../../../../../../../src/api/control-plane/repositories/providers/source/source-pin.ts', () => ({
	resolveAuthorizedSourceCommit: vi.fn(async () => 'd'.repeat(40)),
}));

describe('workday-owned planning context', () => {
	beforeEach(() => { vi.clearAllMocks(); gateway.repositoryId = 'library'; });
	it('resolves the selected objective ID to its canonical path at the frozen project context commit', async () => {
		const held = { store: 'treedx', model: 'knowledge', id: 'project-context', repository: 'library',
			commit: 'a'.repeat(40), path: 'README.md' };
		const definition = { schemaVersion: 'treeseed.objective/v1', id: 'required-work', projectId: candidate.node.projectId,
			title: 'Finish retained source delivery', outcome: 'Release the real reviewed contribution.', status: 'active' };
		const path = 'objectives/release/retained-contribution.mdx', source = `---\n${JSON.stringify(definition)}\n---\n\nRequired release work.\n`;
		const parameters = { objectiveRefs: [definition.id], workdayContextByProjectId: { [candidate.node.projectId]: held } };
		const store = { first: vi.fn(async () => ({ parameters_json: JSON.stringify(parameters) })) };
		gateway.queryRepository.mockResolvedValue({ resolvedRef: held.commit, results: [{ path, frontmatter: definition }], page: { hasMore: false } });
		gateway.readRepositoryFile.mockResolvedValue({ resolvedRef: held.commit, file: { path, frontmatter: definition, content: source } });
		const node = executionNodeSchema.parse({ ...candidate.node, kind: 'planning', pairRole: null, workItemId: undefined,
			workdayId: 'workday', workspace: 'treedx', sourceRef: { store: 'postgresql', model: 'workday', id: 'workday' },
			requestedPermissions: { content: { read: ['knowledge', 'objective'], write: ['proposal'] }, tools: [] } });
		const original = structuredClone(parameters);
		expect(await workItemContext(store, node)).toEqual([held, {
			store: 'treedx', model: 'objective', id: definition.id, repository: held.repository, commit: held.commit, path,
			digest: `sha256:${createHash('sha256').update(source).digest('hex')}`,
		}]);
		expect(gateway.queryRepository).toHaveBeenCalledWith(expect.objectContaining({ repoId: held.repository,
			ref: held.commit, type: 'frontmatter', paths: ['objectives/**'],
			filters: [{ field: 'frontmatter.id', op: 'eq', value: definition.id }] }));
		expect(gateway.readRepositoryFile).toHaveBeenCalledWith(expect.objectContaining({ ref: held.commit, path }));
		expect(parameters).toEqual(original);
	});
	it('pins authorized read-only source before issuing a TreeDX planning assignment', async () => {
		const held = { store: 'treedx', model: 'knowledge', id: 'project-context', repository: 'library',
			commit: 'a'.repeat(40), path: 'README.md' };
		const parameters = { workdayContextByProjectId: { [candidate.node.projectId]: held } };
		const repository = { id: 'source', role: 'software', provider: 'github', owner: 'treeseed-ai',
			name: 'deployment', currentBranch: 'staging' };
		const store = { first: vi.fn(async () => ({ parameters_json: JSON.stringify(parameters) })),
			listHubRepositories: vi.fn(async () => [repository]) };
		const original = structuredClone(parameters);
		for (const kind of ['planning', 'estimating'] as const) {
			const node = executionNodeSchema.parse({ ...candidate.node, kind, pairRole: null, workItemId: undefined,
				workdayId: 'workday', workspace: 'treedx', sourceRef: { store: 'postgresql', model: 'workday', id: 'workday' },
				requestedPermissions: { content: { read: ['knowledge'], write: ['proposal'] }, tools: ['source.read'] } });
			const scope = structuredClone(node);
			expect(await workItemContext(store, node)).toEqual([held, {
				store: 'git', model: 'repository', id: 'source', repository: 'treeseed-ai/deployment', commit: 'd'.repeat(40),
			}]);
			expect(node).toEqual(scope);
		}
		expect(resolveAuthorizedSourceCommit).toHaveBeenCalledTimes(2);
		expect(parameters).toEqual(original);
	});
	it.each(['missing', 'ambiguous', 'query-moved', 'read-moved', 'foreign-project', 'changed-id',
		'unsafe-path', 'query-wrong-id', 'malformed-frontmatter', 'noncanonical-model', 'missing-bytes',
		'page-more', 'repository-moved'])('denies %s objective custody without inventing or changing context', async failure => {
		const f = objectiveScope(), original = structuredClone(f.context);
		if (failure === 'missing') f.query.results = [];
		if (failure === 'ambiguous') f.query.results.push(structuredClone(f.query.results[0]!));
		if (failure === 'query-moved') f.query.resolvedRef = 'b'.repeat(40);
		if (failure === 'read-moved') f.read.resolvedRef = 'b'.repeat(40);
		if (failure === 'foreign-project') f.read.file.content = f.source({ projectId: 'foreign-project' });
		if (failure === 'changed-id') f.read.file.content = f.source({ id: 'another-objective' });
		if (failure === 'unsafe-path') f.query.results[0]!.path = 'objectives/../agents/other.mdx';
		if (failure === 'query-wrong-id') f.query.results[0]!.frontmatter.id = 'another-objective';
		if (failure === 'malformed-frontmatter') f.read.file.content = '---\n{ broken\n---\n';
		if (failure === 'noncanonical-model') f.read.file.content = f.source({ schemaVersion: 'treeseed.objective/v99' });
		if (failure === 'missing-bytes') f.read.file.content = '';
		if (failure === 'page-more') f.query.page.hasMore = true;
		if (failure === 'repository-moved') gateway.repositoryId = 'other-library';
		await expect(workdayObjectiveContext({}, f.projectId, [f.id], f.context)).rejects.toMatchObject({
			code: 'execution_node_workday_objective_invalid', status: 409,
		});
		expect(f.context).toEqual(original);
	});
	it('uses one exact source for duplicate selectors and leaves unselected workdays alone', async () => {
		const f = objectiveScope();
		const refs = await workdayObjectiveContext({}, f.projectId, [f.id, f.id], f.context);
		expect(refs).toHaveLength(1); expect(refs[0]).toMatchObject({ id: f.id, commit: f.context.commit, path: f.read.file.path });
		expect(gateway.queryRepository).toHaveBeenCalledTimes(1);
		for (const selectors of [undefined, []]) expect(await workdayObjectiveContext({}, f.projectId, selectors, f.context)).toEqual([]);
		expect(gateway.queryRepository).toHaveBeenCalledTimes(1);
	});
	it.each([null, {}, 1, [''], [' padded '], [3]])('rejects malformed selectors %j', async selectors => {
		const f = objectiveScope();
		await expect(workdayObjectiveContext({}, f.projectId, selectors, f.context)).rejects.toMatchObject({
			code: 'execution_node_workday_objective_invalid', status: 409,
		});
		expect(gateway.queryRepository).not.toHaveBeenCalled();
	});
});

function objectiveScope() {
	const context = { store: 'treedx' as const, model: 'knowledge', id: 'context', repository: 'library',
		commit: 'a'.repeat(40), path: 'README.md' };
	const definition = { schemaVersion: 'treeseed.objective/v1', id: 'required-work', projectId: candidate.node.projectId,
		title: 'Retained contribution', outcome: 'Release meaningful reviewed work.', status: 'active' };
	const source = (changes: Record<string, unknown> = {}) => `---\n${JSON.stringify({ ...definition, ...changes })}\n---\n\nRetained contribution.\n`;
	const path = 'objectives/release/different-canonical-name.mdx';
	const query = { resolvedRef: context.commit, results: [{ path, frontmatter: { ...definition } }], page: { hasMore: false } };
	const read = { resolvedRef: context.commit, file: { path, content: source(), frontmatter: definition } };
	gateway.queryRepository.mockResolvedValue(query); gateway.readRepositoryFile.mockResolvedValue(read);
	return { context, id: definition.id, projectId: definition.projectId, query, read, source };
}
