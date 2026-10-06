import { describe, expect, it, vi } from 'vitest';
import { completedGraphRefresh, treeDxResult } from '../../../../src/operations-runner/knowledge/publication-executor.ts';

describe('knowledge publication graph refresh', () => {
	it('unwraps TreeDX graph and refresh-job envelopes', async () => {
		const client = {
			refreshGraph: vi.fn(async () => ({ graph: { jobId: 'graph-job-1', graphVersion: null } })),
			getGraphRefreshJob: vi.fn(async () => ({ job: { status: 'completed', graphVersion: 'graph-1' } })),
		};

		await expect(completedGraphRefresh(client, { repoId: 'repo-1', ref: 'refs/heads/staging' }))
			.resolves.toMatchObject({ jobId: 'graph-job-1', graphVersion: 'graph-1' });
		expect(client.getGraphRefreshJob).toHaveBeenCalledOnce();
	});

	it('unwraps the search-index envelope used for source-closure checks', () => {
		expect(treeDxResult({ index: { resolvedRef: 'abc', stale: false } }, 'index'))
			.toEqual({ resolvedRef: 'abc', stale: false });
	});
});
