import { resolveKnowledgeGatewayConnection } from '../../knowledge/gateway-treedx-connection.ts';
import { currentReviewIds, reviewWorkspaceAvailable } from '../../knowledge/review-revision.ts';
import { createRevisionWorkspace, discardRevisionWorkspace } from '../../knowledge/review-revision.ts';
import { editorialReviewGate } from '../../knowledge/editorial-review.ts';
import { simulationEvidence } from '../../store/governance/policy/support/simulation-evidence.ts';
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

		async decide(principal: KnowledgePrincipal, reviewId: string, input: Record<string, unknown>) {
			const { review, workspace } = await reviewWorkspace(store, reviewId);
			const access = await authorization.project(principal, workspace.projectId, 'knowledge:review');
			const simulation = await simulationPolicy(store, workspace, input);
			const selfDecision = workspace.actorUserId === access.principal.id;
			if (selfDecision) await authorization.project(principal, workspace.projectId, 'knowledge:publish');
			if (Number(input.version) !== workspace.version) throw new KnowledgeOperationError(409, 'stale_knowledge_review', 'The review workspace changed. Reload before deciding.');
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: workspace.projectId,
				write: false, workspaceRefs: [workspace.branchName] });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_review_diff_unavailable', 'The review diff is unavailable. Review decisions fail closed.');
			const diff = await connection.client.diff({ workspaceId: workspace.treeDxWorkspaceId });
			if (!pathsMatch(review.changedPaths, diff.changedPaths)) throw new KnowledgeOperationError(409, 'knowledge_review_diff_changed', 'The review diff no longer matches its submitted snapshot.');
			const decision = text(input.decision);
			if (!['approve', 'request-changes'].includes(decision)) throw new KnowledgeOperationError(422, 'invalid_review_decision', 'Choose approve or request changes.');
			if (decision === 'request-changes' && !text(input.notes)) throw new KnowledgeOperationError(422, 'review_notes_required', 'Explain the requested changes.');
			let decisionPrincipalId = access.principal.id;
			if (decision === 'approve') {
				if (review.requiresEditorialReview) decisionPrincipalId = (await authorization.project(principal, workspace.projectId, 'knowledge:publish')).principal.id;
				const gate = editorialReviewGate(review);
				if (!gate.ok) throw new KnowledgeOperationError(409, gate.code, 'Required editorial reviews have not approved this exact revision.');
				const open = await store.first("SELECT COUNT(*) AS count FROM knowledge_review_comments WHERE review_id = ? AND status = 'open'", [reviewId]);
				if (Number(open?.count ?? 0) > 0) throw new KnowledgeOperationError(409, 'knowledge_review_comments_open', 'Resolve every review comment before approval.');
			}
			let revisionConnection: any = null, revisionWorkspace: any = null;
			if (decision === 'request-changes') {
				revisionConnection = await resolveKnowledgeGatewayConnection(store, { projectId: workspace.projectId,
					write: true, workspaceRefs: [workspace.branchName] });
				if (!revisionConnection) throw new KnowledgeOperationError(503, 'knowledge_revision_unavailable', 'A writable revision workspace is unavailable.');
				try { revisionWorkspace = await createRevisionWorkspace(revisionConnection, workspace, review.commitSha); }
				catch { throw new KnowledgeOperationError(409, 'knowledge_revision_branch_changed', 'The reviewed branch changed before a revision workspace could be created.'); }
			}
			const result = await store.decideKnowledgeReview(reviewId, { decision, decidedByUserId: decisionPrincipalId,
				notes: text(input.notes) || null, workspaceId: workspace.id, workspaceVersion: workspace.version, revisionWorkspace });
			if (!result.ok) {
				await discardRevisionWorkspace(revisionConnection, revisionWorkspace);
				throw new KnowledgeOperationError(409, 'stale_knowledge_review', 'This review was already decided.');
			}
			await store.recordAuditEvent({ eventType: decision === 'approve'
				? selfDecision ? 'knowledge.staging_release.self_approved' : 'knowledge.review.approved'
				: 'knowledge.review.changes_requested',
				actorType: 'user', actorId: decisionPrincipalId, targetType: 'knowledge_review', targetId: reviewId,
				data: { workspaceId: workspace.id, projectId: workspace.projectId, commitSha: review.commitSha,
					simulation: { ...simulation.evidence, operatorPrincipalId: access.principal.id }, productionApproval: simulation.production } });
			return result.review;
		},

		async publish(principal: KnowledgePrincipal, reviewId: string, input: Record<string, unknown>) {
			const { review, workspace } = await reviewWorkspace(store, reviewId);
			const access = await authorization.project(principal, workspace.projectId, 'knowledge:publish');
			const targetEnvironment = text(input.targetEnvironment) || 'staging';
			if (!['staging', 'production'].includes(targetEnvironment)) throw new KnowledgeOperationError(422,
				'knowledge_release_environment_invalid', 'Choose the staging or production release environment.');
			if (targetEnvironment === 'production') {
				if (access.principal.id.startsWith('capacity-provider:') || access.principal.id.startsWith('service-principal:')) {
					throw new KnowledgeOperationError(403, 'human_production_approval_required', 'A human principal must approve production promotion.');
				}
				throw new KnowledgeOperationError(409, 'hosted_deployment_suspended', 'Production knowledge promotion remains disabled while hosted deployment is suspended.');
			}
			const simulation = await simulationPolicy(store, workspace, input);
			if (simulation.production) throw new KnowledgeOperationError(409, 'hosted_deployment_suspended', 'Production knowledge publication remains disabled while hosted deployment is suspended.');
			if (review.status !== 'approved' || workspace.status !== 'approved' || !review.commitSha) {
				throw new KnowledgeOperationError(409, 'knowledge_review_not_publishable', 'Only an approved, unchanged knowledge review can be published.');
			}
			const gate = editorialReviewGate(review);
			if (!gate.ok) throw new KnowledgeOperationError(409, gate.code, 'The editorial review gate is incomplete.');
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: workspace.projectId, write: false });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_repository_unavailable', 'The project knowledge repository is unavailable.');
			const publication = await store.createKnowledgePublication({ workspaceId: workspace.id, reviewId,
				projectId: workspace.projectId, commitSha: review.commitSha, publishedRef: connection.publicationRef });
			const operation = await store.createPlatformOperation({ namespace: 'knowledge', operation: 'publish_review',
				target: 'control_plane_operations_runner', idempotencyKey: `knowledge-publication:${publication.id}`,
				input: { publicationId: publication.id, targetEnvironment,
					simulation: { ...simulation.evidence, operatorPrincipalId: access.principal.id } },
				requestedByType: 'user', requestedById: access.principal.id });
			return { publication, operation };
		},
	};
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

async function reviewWorkspace(store: any, reviewId: string) {
	const review = await store.getKnowledgeReview(reviewId);
	if (!review) throw new KnowledgeOperationError(404, 'knowledge_review_not_found', 'Knowledge review not found.');
	const workspace = await store.getKnowledgeWorkspace(review.workspaceId);
	if (!workspace) throw new KnowledgeOperationError(409, 'knowledge_review_workspace_missing', 'The review workspace is no longer available.');
	return { review, workspace };
}

function pathsMatch(recorded: unknown, current: unknown) {
	if (!Array.isArray(recorded) || !Array.isArray(current) || recorded.length === 0) return false;
	return [...recorded].map(String).sort().join('\n') === [...current].map(String).sort().join('\n');
}

async function simulationPolicy(store: any, workspace: any, input: Record<string, unknown>) {
	const evidence = simulationEvidence(input);
	if (evidence.productionAuthorityRequested !== true) return { evidence, production: false };
	const project = await store.getProject(workspace.projectId);
	if (project?.metadata?.allowSimulatedHumanProductionApproval !== true) {
		throw new KnowledgeOperationError(403, 'simulated_human_production_policy_required', 'This project does not allow simulated-human production approval.');
	}
	return { evidence, production: true };
}
