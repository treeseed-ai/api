import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeReviewMethod, decideKnowledgeReviewMethod,
	submitKnowledgeWorkspaceMethod } from '../../../../src/api/store/knowledge/collaboration.ts';

describe('knowledge review persistence', () => {
	it('captures immutable changed paths with the submitted commit', async () => {
		const run = vi.fn().mockResolvedValue({ success: true });
		const first = vi.fn().mockResolvedValue({ id: 'review-a', workspace_id: 'workspace-a', status: 'open',
			submitted_by_user_id: 'author-a', commit_sha: 'abc123', changed_paths_json: '["a.md","b.md"]',
			created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z' });
		const store = { ensureInitialized: vi.fn(), run, first };

		const review = await createKnowledgeReviewMethod.call(store as never, { id: 'review-a', workspaceId: 'workspace-a',
			submittedByUserId: 'author-a', commitSha: 'abc123', changedPaths: ['a.md', 'b.md'] });

		expect(run.mock.calls[0][1]).toContain('["a.md","b.md"]');
		expect(review).toMatchObject({ changedPaths: ['a.md', 'b.md'], commitSha: 'abc123' });
	});

	it('changes the review and workspace through one locked statement', async () => {
		const first = vi.fn().mockResolvedValue({ id: 'review-a' });
		const store = { ensureInitialized: vi.fn(), first,
			getKnowledgeReview: vi.fn().mockResolvedValue({ id: 'review-a', status: 'approved' }),
			getKnowledgeWorkspace: vi.fn().mockResolvedValue({ id: 'workspace-a', status: 'approved', version: 3 }) };

		const result = await decideKnowledgeReviewMethod.call(store as never, 'review-a', { decision: 'approve',
			decidedByUserId: 'reviewer-a', workspaceId: 'workspace-a', workspaceVersion: 2 });

		expect(first.mock.calls[0][0]).toContain('FOR UPDATE OF reviews, workspaces');
		expect(first.mock.calls[0][0]).toContain('updated_workspace');
		expect(first.mock.calls[0][0]).toContain('treedx_workspace_id = COALESCE');
		expect(first.mock.calls[0][0]).not.toContain('base_commit_sha = COALESCE');
		expect(result).toMatchObject({ ok: true, review: { status: 'approved' }, workspace: { status: 'approved', version: 3 } });
	});

	it('creates the submitted review and advances the workspace in one locked statement', async () => {
		const first = vi.fn().mockResolvedValue({ id: 'review-submit' });
		const store = { ensureInitialized: vi.fn(), first,
			getKnowledgeReview: vi.fn().mockResolvedValue({ id: 'review-submit', status: 'open', commitSha: 'abc123' }),
			getKnowledgeWorkspace: vi.fn().mockResolvedValue({ id: 'workspace-a', status: 'submitted', version: 4 }),
			getKnowledgeReviewByWorkspace: vi.fn() };

		const result = await submitKnowledgeWorkspaceMethod.call(store as never, { id: 'review-submit',
			workspaceId: 'workspace-a', workspaceVersion: 3, submittedByUserId: 'author-a',
			commitSha: 'abc123', changedPaths: ['docs/page.md'] });

		expect(first.mock.calls[0][0]).toContain('FOR UPDATE');
		expect(first.mock.calls[0][0]).toContain('updated_workspace');
		expect(first.mock.calls[0][0]).toContain('inserted_review');
		expect(result).toMatchObject({ ok: true, review: { id: 'review-submit' },
			workspace: { status: 'submitted', version: 4 } });
	});

	it('atomically adopts a replacement writable TreeDX workspace for requested revisions', async () => {
		const first = vi.fn().mockResolvedValue({ id: 'review-a' });
		const store = { ensureInitialized: vi.fn(), first,
			getKnowledgeReview: vi.fn().mockResolvedValue({ id: 'review-a', status: 'changes-requested' }),
			getKnowledgeWorkspace: vi.fn().mockResolvedValue({ id: 'workspace-a', status: 'changes-requested', version: 5 }) };
		const revisionWorkspace = { workspaceId: 'ws-revision', baseRef: 'refs/heads/knowledge/a',
			baseCommitSha: 'abc123', branchName: 'refs/heads/knowledge/a' };

		await decideKnowledgeReviewMethod.call(store as never, 'review-a', { decision: 'request-changes',
			decidedByUserId: 'reviewer-a', workspaceId: 'workspace-a', workspaceVersion: 4, revisionWorkspace });

		expect(first.mock.calls[0][1]).toContain(revisionWorkspace.workspaceId);
		expect(first.mock.calls[0][1]).not.toContain(revisionWorkspace.baseCommitSha);
	});
});
