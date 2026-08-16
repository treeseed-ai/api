import { describe,expect,it,vi } from 'vitest';
import { listTreeDxPlanningDemandSources } from '../../../../../src/api/capacity/services/capacity/workdays/content/workday-content-demand-source.ts';

describe('workday TreeDX planning content admission', () => {
	it('fails visibly with field diagnostics when a planning record is not model-valid', async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
			ok: true,
			results: [{ path: 'src/content/objectives/invalid.mdx', frontmatter: { status: 'planned' }, body: 'Missing title.' }],
		}), { status: 200, headers: { 'content-type': 'application/json' } }));
		const store = {
			config: { TREESEED_API_BASE_URL: 'http://127.0.0.1:3000', fetchImpl },
			getProjectTreeDxLibrary: vi.fn(async () => ({ repositoryId: 'treeseed-project-a' })),
		};

		await expect(listTreeDxPlanningDemandSources(store, {
			id: 'run-a', parameters: {},
		} as never, { id: 'project-a', slug: 'project-a', metadata: { architecture: { contentPath: 'src/content' } } }))
			.rejects.toMatchObject({
				code: 'capacity_workday_content_model_invalid', status: 409,
				details: {
					path: 'src/content/objectives/invalid.mdx', model: 'objective',
					diagnostics: [expect.objectContaining({ field: 'title', code: 'content_zod_invalid_type' })],
				},
			});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
