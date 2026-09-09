import { describe, expect, it, vi } from 'vitest';
import { admitStagingPublication } from '../../../../src/api/control-plane/knowledge/staging-admission.ts';
import { createKnowledgeReviewService } from '../../../../src/api/control-plane/knowledge/knowledge-review-service.ts';

function fixture() {
	const review = { id: 'review', workspaceId: 'workspace', status: 'open', commitSha: 'exact-commit', changedPaths: ['books/guide.md'], requiresEditorialReview: true, editorialGateSatisfied: false };
	const workspace = { id: 'workspace', projectId: 'project', actorUserId: 'author', status: 'submitted', version: 11, treeDxWorkspaceId: 'remote' };
	const store = {
		decideKnowledgeReview: vi.fn(async () => ({ ok: true })), recordAuditEvent: vi.fn(async () => undefined),
		getKnowledgeReview: vi.fn(async () => review), getKnowledgeWorkspace: vi.fn(async () => workspace),
		getProjectDetails: vi.fn(async () => ({ project: { id: 'project', teamId: 'team' } })),
		principalCanAccessTeam: vi.fn(async () => true), getTeamAccessSummary: vi.fn(async () => ({ permissions: ['knowledge:publish', 'knowledge:review'] })),
		listKnowledgeReviews: vi.fn(async () => [review]), listKnowledgeReviewComments: vi.fn(async () => []), listKnowledgeWorkspacePresence: vi.fn(async () => []),
	};
	const connection = { client: { diff: vi.fn(async () => ({ changedPaths: review.changedPaths })), status: vi.fn(async () => ({ status: 'committed', commitSha: review.commitSha, changes: [] as unknown[] })) } };
	return { review, workspace, store, connection };
}

describe('staging library admission', () => {
	it('uses the observed workspace version for callers submitting only an immutable review ID', async () => {
		const f = fixture();
		await admitStagingPublication(f.store, f.connection, f.review, f.workspace, 'author', undefined);
		expect(f.store.decideKnowledgeReview).toHaveBeenCalledWith('review', expect.objectContaining({ workspaceVersion: 11 }));
	});
	it('admits an author-owned historical revision without independent or editorial approval', async () => {
		const f = fixture();
		await admitStagingPublication(f.store, f.connection, f.review, f.workspace, 'author', 11);
		expect(f.store.decideKnowledgeReview).toHaveBeenCalledWith('review', expect.objectContaining({ decidedByUserId: 'author', workspaceVersion: 11 }));
	});
	it.each(['version', 'commit', 'paths', 'dirty', 'ready', 'expired', 'rejected'])('rejects changed or unavailable revision: %s', async (kind) => {
		const f = fixture();
		if (kind === 'commit') f.connection.client.status.mockResolvedValue({ status: 'committed', commitSha: 'moved', changes: [] });
		if (kind === 'paths') f.connection.client.diff.mockResolvedValue({ changedPaths: ['books/other.md'] });
		if (kind === 'dirty') f.connection.client.status.mockResolvedValue({ status: 'committed', commitSha: 'exact-commit', changes: [{ path: 'books/unreviewed.md' }] });
		if (kind === 'ready' || kind === 'expired') f.connection.client.status.mockResolvedValue({ status: kind, commitSha: 'exact-commit', changes: [] });
		if (kind === 'rejected') f.review.status = 'changes-requested';
		await expect(admitStagingPublication(f.store, f.connection, f.review, f.workspace, 'author', kind === 'version' ? 10 : 11)).rejects.toBeDefined();
		expect(f.store.decideKnowledgeReview).not.toHaveBeenCalled();
	});
	it('admits exact retained overlays from an immutable committed TreeDX workspace', async () => {
		const f = fixture(); f.review.status = f.workspace.status = 'approved';
		f.connection.client.status.mockResolvedValue({ status: 'committed', commitSha: 'exact-commit', changes: [{ path: 'books/guide.md', status: 'added' }] });
		await admitStagingPublication(f.store, f.connection, f.review, f.workspace, 'author', 11);
		expect(f.store.decideKnowledgeReview).not.toHaveBeenCalled();
	});
	it('does not decide an already admitted revision twice', async () => {
		const f = fixture(); f.review.status = f.workspace.status = 'approved';
		await admitStagingPublication(f.store, f.connection, f.review, f.workspace, 'author', 11);
		expect(f.store.decideKnowledgeReview).not.toHaveBeenCalled();
	});
	it('exposes direct publication for an authorized author without an approval step', async () => {
		const f = fixture();
		const result = await createKnowledgeReviewService(f.store).list({ id: 'author' }, 'team');
		expect(result.items[0]).toMatchObject({ canPublish: true, canApproveEditorial: false });
	});
	it('rejects unauthorized publication before admission', async () => {
		const f = fixture(); f.store.principalCanAccessTeam.mockResolvedValue(false);
		await expect(createKnowledgeReviewService(f.store).publish({ id: 'outsider' }, 'review', { version: 11 })).rejects.toMatchObject({ code: 'knowledge_access_denied' });
		expect(f.store.decideKnowledgeReview).not.toHaveBeenCalled();
	});
	it.each(['author', 'service-principal:agent'])('retains production boundary for %s', async (id) => {
		const f = fixture();
		await expect(createKnowledgeReviewService(f.store).publish({ id }, 'review', { version: 11, targetEnvironment: 'production' })).rejects.toBeDefined();
		expect(f.store.decideKnowledgeReview).not.toHaveBeenCalled();
	});
});
