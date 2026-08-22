import { resolveKnowledgeGatewayConnection } from '../../knowledge/gateway-treedx-connection.ts';
import { currentReviewIds, reviewWorkspaceAvailable } from '../../knowledge/review-revision.ts';
import { createKnowledgeAuthorization, type KnowledgePrincipal } from './knowledge-authorization.ts';
import { KnowledgeOperationError } from './knowledge-operation-error.ts';
import { allowedKnowledgePath } from './knowledge-path.ts';

export function createKnowledgeReviewService(store: any) {
	const authorization = createKnowledgeAuthorization(store);
	return {
		async list(principal: KnowledgePrincipal, teamId: string) {
			const access = await authorization.team(principal, teamId, 'knowledge:review');
			const reviews = await store.listKnowledgeReviews(teamId);
			const currentIds = currentReviewIds(reviews);
			return { items: await Promise.all(reviews.map(async (review: any) => {
				const workspace = await store.getKnowledgeWorkspace(review.workspaceId);
				let canPublish = false;
				if (workspace) {
					try { await authorization.project(principal, workspace.projectId, 'knowledge:publish'); canPublish = true; } catch { /* no publication authority */ }
				}
				const current = currentIds.has(review.id);
				const available = Boolean(workspace && current && reviewWorkspaceAvailable(review.status, workspace.status));
				return { ...review, comments: await store.listKnowledgeReviewComments(review.id),
					presence: await store.listKnowledgeWorkspacePresence(review.workspaceId), isCurrentRevision: current,
					workspaceAvailable: available, canDecide: Boolean(available && review.status === 'open' && workspace.actorUserId !== access.principal.id),
					canApproveEditorial: Boolean(available && review.status === 'open' && workspace.actorUserId !== access.principal.id && canPublish),
					canPublish: Boolean(available && review.status === 'approved' && canPublish) };
			})) };
		},

		async comment(principal: KnowledgePrincipal, reviewId: string, input: Record<string, unknown>) {
			const review = await store.getKnowledgeReview(reviewId);
			if (!review) throw new KnowledgeOperationError(404, 'knowledge_review_not_found', 'Knowledge review not found.');
			const workspace = await store.getKnowledgeWorkspace(review.workspaceId);
			if (!workspace) throw new KnowledgeOperationError(409, 'knowledge_review_workspace_missing', 'The review workspace is no longer available.');
			const access = await authorization.project(principal, workspace.projectId, 'knowledge:review');
			const body = text(input.body), path = text(input.path);
			if (!body || body.length > 4_000) throw new KnowledgeOperationError(422, 'knowledge_review_comment_invalid', 'Enter a review comment of 4,000 characters or fewer.');
			if (!allowedKnowledgePath(workspace, path)) throw new KnowledgeOperationError(422, 'knowledge_path_invalid', 'Choose a changed knowledge file.');
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: workspace.projectId,
				write: false, workspaceRefs: [workspace.branchName] });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_review_diff_unavailable', 'The review diff is unavailable.');
			const diff = await connection.client.diff({ workspaceId: workspace.treeDxWorkspaceId });
			if (!diff.changedPaths.includes(path)) throw new KnowledgeOperationError(422, 'knowledge_review_path_unchanged', 'Review comments must refer to a changed file.');
			const created = await store.createKnowledgeReviewComment({ reviewId, authorUserId: access.principal.id, path,
				lineStart: Number(input.lineStart) || null, lineEnd: Number(input.lineEnd) || null, body });
			await store.recordAuditEvent({ eventType: 'knowledge.review.comment_added', actorType: 'user', actorId: access.principal.id,
				targetType: 'knowledge_review', targetId: reviewId, data: { workspaceId: workspace.id,
					projectId: workspace.projectId, commentId: created.id, path } });
			return created;
		},
	};
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
