import { beforeEach, expect, it, vi } from 'vitest';
import { commitInboxQuestion } from '../../../../../src/api/control-plane/inbox/question-content.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';
import { applyTextChangeset } from '../../../../../src/api/knowledge/changesets/apply-text-changeset.ts';
import { recordTreeDxAuthoringState } from '../../../../../src/api/capacity/services/treedx/repositories/treedx-authoring-journal.ts';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', async original => ({
	...await original<object>(), resolveKnowledgeGatewayConnection: vi.fn(),
}));
vi.mock('../../../../../src/api/knowledge/changesets/apply-text-changeset.ts', () => ({ applyTextChangeset: vi.fn() }));
vi.mock('../../../../../src/api/capacity/services/treedx/repositories/treedx-authoring-journal.ts', () => ({ recordTreeDxAuthoringState: vi.fn() }));

const commit = 'a'.repeat(40);
let readback: 'exact' | 'moved' | 'wrong-path' | 'changed-bytes' | 'missing' = 'exact';
const closeWorkspace = vi.fn(async () => undefined);
const input = () => ({ store: { getProjectTreeDxLibrary: vi.fn(async (): Promise<{ contentPath: string } | null> => ({ contentPath: '.' })) },
	teamId: 'team', projectId: 'deployment', principal: { id: 'coordinator' },
	title: 'Activate reviewed origin transport', markdown: 'Adopt the reviewed transport before Releaser integration.',
	severity: 'blocking' as const, relatedObjectives: [], relatedProposals: ['origin-proposal'],
	relatedDecisions: ['origin-decision'], relatedWorkItems: ['simulated-origin-delivery'] });

beforeEach(() => {
	vi.clearAllMocks();
	readback = 'exact';
	vi.mocked(resolveKnowledgeGatewayConnection).mockImplementation(async (_store, scope) => ({
		contentPath: '.', repositoryId: 'library', baseRef: 'b'.repeat(40), authoringBranch: 'staging',
		client: { closeWorkspace,
			createWorkspace: async () => ({ workspaceId: 'workspace', baseCommitSha: 'b'.repeat(40), baseRef: 'refs/heads/staging' }),
			commit: async () => ({ commitSha: commit, branchName: 'refs/heads/staging', changedPaths: [] }),
			readRepositoryFiles: async ({ paths }: { paths: string[] }) => {
				if (!paths.every(path => scope.workspacePaths?.includes(path))) throw new Error('Permission denied.');
				const change = vi.mocked(applyTextChangeset).mock.calls[0]?.[0].changes[0];
				return { resolvedRef: readback === 'moved' ? 'c'.repeat(40) : commit,
					files: readback === 'missing' ? [] : [{ path: readback === 'wrong-path' ? 'questions/other.mdx' : paths[0],
						content: readback === 'changed-bytes' ? `${change?.after}\n` : change?.after }] };
			},
		},
	} as unknown as NonNullable<Awaited<ReturnType<typeof resolveKnowledgeGatewayConnection>>>));
	vi.mocked(applyTextChangeset).mockImplementation(async ({ changes }) => {
		const writeScope = vi.mocked(resolveKnowledgeGatewayConnection).mock.calls.find(([, scope]) => scope.write)?.[1];
		if (!changes.every(change => writeScope?.workspacePaths?.includes(change.path))) throw new Error('Permission denied.');
	});
});

it.each(['moved', 'wrong-path', 'changed-bytes', 'missing'] as const)('retains failure and closes the workspace for %s readback', async value => {
	readback = value;
	await expect(commitInboxQuestion(input())).rejects.toMatchObject({ code: 'inbox_question_readback_failed' });
	expect(recordTreeDxAuthoringState).not.toHaveBeenCalled(); expect(closeWorkspace).toHaveBeenCalledWith('workspace');
});

it.each(['.', 'portfolio/library'])('authors and reads the exact question with narrow scope under %s', async contentPath => {
	const request = input(); request.store.getProjectTreeDxLibrary.mockResolvedValue({ contentPath });
	const result = await commitInboxQuestion(request);
	expect(result.path).toMatch(new RegExp(`^${contentPath === '.' ? '' : `${contentPath}/`}questions/activate-reviewed-origin-transport-[a-f0-9]{8}\\.mdx$`, 'u'));
	expect(result.source).toContain('simulated-origin-delivery');
	for (const [, scope] of vi.mocked(resolveKnowledgeGatewayConnection).mock.calls) {
		expect(scope.workspacePaths).toEqual([result.path]); expect(scope.relationPaths).toBeUndefined();
	}
	expect(vi.mocked(resolveKnowledgeGatewayConnection).mock.calls.at(-1)?.[1].readRefs).toEqual([commit]);
	expect(recordTreeDxAuthoringState).toHaveBeenCalledOnce(); expect(closeWorkspace).toHaveBeenCalledWith('workspace');
});

it('does not acquire authoring authority when the project library is unavailable', async () => {
	const request = input(); request.store.getProjectTreeDxLibrary.mockResolvedValue(null);
	await expect(commitInboxQuestion(request)).rejects.toMatchObject({ code: 'inbox_treedx_unavailable' });
	expect(resolveKnowledgeGatewayConnection).not.toHaveBeenCalled(); expect(applyTextChangeset).not.toHaveBeenCalled();
});

it('rejects an unsafe library root before acquiring authoring authority', async () => {
	const request = input(); request.store.getProjectTreeDxLibrary.mockResolvedValue({ contentPath: '../other' });
	await expect(commitInboxQuestion(request)).rejects.toThrow('unsafe');
	expect(resolveKnowledgeGatewayConnection).not.toHaveBeenCalled();
});
