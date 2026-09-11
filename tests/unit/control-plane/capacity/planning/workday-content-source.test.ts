import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listTreeDxPlanningDemandSources } from '../../../../../src/api/capacity/services/capacity/workdays/content/workday-content-demand-source.ts';
import type { DurableCapacityWorkdayRun } from '../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
import { bindPlanningContentIntent } from '../../../../../src/api/capacity/services/support/planning-demand-source.ts';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), search: vi.fn(), read: vi.fn(), validate: vi.fn() }));
vi.mock('../../../../../src/api/capacity/services/capacity/workdays/treedx/workday-treedx-connection.ts', () => ({ resolveWorkdayTreeDxConnection: mocks.resolve }));
vi.mock('@treeseed/sdk/content-validation', () => ({ validatePortableContentData: mocks.validate }));
const commit = 'a'.repeat(40);
const run = { id: 'run-1', parameters: { repositoryIdsBySlug: { sdk: 'wrong-guessed-repository' } } } as unknown as DurableCapacityWorkdayRun;
function fixture(ref: string | undefined = 'refs/remotes/origin/staging', contentPath = '.') {
	return { config: {}, getProjectTreeDxLibrary: vi.fn(async () => ({ repositoryId: 'assigned-library', contentPath, contentRepositoryRef: ref })) };
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolve.mockResolvedValue({ repositoryId: 'assigned-library', client: { searchRepositoryFiles: mocks.search, readRepositoryFiles: mocks.read } });
	mocks.search.mockResolvedValue({ resolvedRef: commit, results: [] });
	mocks.validate.mockReturnValue({ ok: true });
});

describe('selected planning subject', () => {
	const intent = { objective: 'Review the proposal', artifactKind: 'proposal_feedback_note', subjectModel: 'proposal', subjectId: null, includeWorkdayArtifacts: true };
	const source = { sourceType: 'proposal' as const, sourceId: 'proposal:task', priority: 70, payload: { model: 'proposal', contentPath: 'proposals/task.md', commitSha: commit, digest: 'b'.repeat(64) } };
	it('binds the selected existing proposal instead of falling back to an objective', () => {
		expect(bindPlanningContentIntent(intent, source)).toMatchObject({ subjectId: 'task', subjectPath: 'proposals/task.md', relatedArtifact: { model: 'proposal', commitSha: commit, digest: 'b'.repeat(64) } });
	});
	it('preserves an explicitly assigned subject or different model', () => {
		const explicit = { ...intent, subjectId: 'other' }, objective = { ...intent, subjectModel: 'objective' };
		expect(bindPlanningContentIntent(explicit, source)).toBe(explicit);
		expect(bindPlanningContentIntent(objective, source)).toBe(objective);
	});
});
describe('workday library source custody', () => {
	it.each(['refs/remotes/origin/staging', 'refs/heads/staging', 'staging', 'main', commit])('uses selected %s and freezes subsequent collections', async ref => {
		await listTreeDxPlanningDemandSources(fixture(ref), run, { id: 'project-1', slug: 'sdk' });
		expect(mocks.resolve.mock.calls[0][1]).not.toHaveProperty('repositoryId');
		expect(mocks.search.mock.calls.map(([input]) => input.ref)).toEqual([ref === commit ? commit : ref === 'main' ? 'refs/heads/main' : 'refs/heads/staging', commit, commit, commit]);
		expect(mocks.search.mock.calls[0][0].paths).toEqual(['objectives/**']);
	});
	it('uses the bound content root rather than source project metadata', async () => {
		await listTreeDxPlanningDemandSources(fixture('staging', 'teams/docs'), run, { id: 'project-1', metadata: { architecture: { contentPath: 'wrong' } } });
		expect(mocks.search.mock.calls[0][0].paths).toEqual(['teams/docs/objectives/**']);
	});
	it.each(['', 'refs/heads/staging', 'b'.repeat(40)])('rejects nonimmutable or changed readback %s', async resolvedRef => {
		mocks.search.mockResolvedValueOnce({ resolvedRef: commit, results: [] }).mockResolvedValueOnce({ resolvedRef, results: [] });
		await expect(listTreeDxPlanningDemandSources(fixture(), run, { id: 'project-1' })).rejects.toMatchObject({ code: 'capacity_workday_content_snapshot_invalid' });
	});
	it('rejects missing selected ref', async () => {
		await expect(listTreeDxPlanningDemandSources(fixture(''), run, { id: 'project-1' })).rejects.toMatchObject({ code: 'capacity_workday_content_ref_missing' });
		expect(mocks.search).not.toHaveBeenCalled();
	});
	it('rejects unsafe content root before querying', async () => {
		await expect(listTreeDxPlanningDemandSources(fixture('staging', '../other'), run, { id: 'project-1' })).rejects.toThrow();
		expect(mocks.search).not.toHaveBeenCalled();
	});
	it('carries immutable provenance and retains content validation', async () => {
		mocks.search.mockResolvedValueOnce({ resolvedRef: commit, results: [{ path: 'objectives/core.mdx', frontmatter: { title: 'Core' }, body: 'Source body' }] });
		const sources = await listTreeDxPlanningDemandSources(fixture(), run, { id: 'project-1' });
		expect(sources[0].payload).toMatchObject({ contentBaseRef: commit, commitSha: commit, contentPath: 'objectives/core.mdx' });
		expect(mocks.validate).toHaveBeenCalledWith('objective', { title: 'Core' });
	});
	it('reads exact proposal bytes for version-safe feedback', async () => {
		mocks.search.mockResolvedValueOnce({ resolvedRef: commit, results: [] }).mockResolvedValueOnce({ resolvedRef: commit, results: [] })
			.mockResolvedValueOnce({ resolvedRef: commit, results: [{ path: 'proposals/task.md', frontmatter: { title: 'Task' } }] });
		mocks.read.mockResolvedValue({ resolvedRef: commit, files: [{ path: 'proposals/task.md', content: 'abc' }] });
		const sources = await listTreeDxPlanningDemandSources(fixture(), run, { id: 'project-1' });
		expect(sources[0].payload.digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(mocks.read.mock.calls[0][0]).toMatchObject({ ref: commit, parseFrontmatter: false });
	});
});
