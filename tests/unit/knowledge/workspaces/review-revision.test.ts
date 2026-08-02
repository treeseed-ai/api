import { describe, expect, it, vi } from 'vitest';
import { createRevisionWorkspace, currentReviewIds, reviewWorkspaceAvailable } from '../../../../src/api/knowledge/review-revision.ts';

describe('knowledge revision workspaces', () => {
	it('keeps completed review history visible but non-actionable', () => {
		expect(reviewWorkspaceAvailable('approved', 'approved')).toBe(true);
		expect(reviewWorkspaceAvailable('approved', 'published')).toBe(false);
		expect(reviewWorkspaceAvailable('open', 'submitted')).toBe(true);
		expect(reviewWorkspaceAvailable('open', 'approved')).toBe(false);
	});
	it('marks only the latest ordered review for each workspace as current', () => {
		expect([...currentReviewIds([
			{ id: 'review-b2', workspaceId: 'workspace-b' },
			{ id: 'review-a2', workspaceId: 'workspace-a' },
			{ id: 'review-a1', workspaceId: 'workspace-a' },
			{ id: 'review-b1', workspaceId: 'workspace-b' },
		])]).toEqual(['review-b2', 'review-a2']);
	});

	it('starts a new writable workspace at the exact reviewed branch commit', async () => {
		const createWorkspace = vi.fn().mockResolvedValue({ workspaceId: 'ws-new',
			baseRef: 'refs/heads/knowledge/a', baseCommitSha: 'abc123', branchName: 'refs/heads/knowledge/a' });
		const connection = { repositoryId: 'repo-a', client: { createWorkspace, closeWorkspace: vi.fn() } } as any;
		const result = await createRevisionWorkspace(connection, { branchName: 'refs/heads/knowledge/a',
			allowedPaths: ['docs/src/content/books/**'] }, 'abc123');

		expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ mode: 'writable',
			baseRef: 'refs/heads/knowledge/a', branchName: 'refs/heads/knowledge/a' }));
		expect(result.workspaceId).toBe('ws-new');
	});

	it('closes and rejects a replacement created from a drifted commit', async () => {
		const closeWorkspace = vi.fn().mockResolvedValue(undefined);
		const connection = { repositoryId: 'repo-a', client: { createWorkspace: vi.fn().mockResolvedValue({
			workspaceId: 'ws-new', baseRef: 'refs/heads/knowledge/a', baseCommitSha: 'different',
			branchName: 'refs/heads/knowledge/a' }), closeWorkspace } } as any;

		await expect(createRevisionWorkspace(connection, { branchName: 'refs/heads/knowledge/a', allowedPaths: ['**'] }, 'abc123'))
			.rejects.toThrow('no longer matches');
		expect(closeWorkspace).toHaveBeenCalledWith('ws-new');
	});
});
