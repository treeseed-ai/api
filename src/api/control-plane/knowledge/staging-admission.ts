import { KnowledgeOperationError } from './knowledge-operation-error.ts';

// Admission validates an exact revision; it is not a human approval boundary.
export async function admitStagingPublication(store: any, connection: any, review: any, workspace: any,
	principalId: string, version: unknown) {
	if (version !== undefined && Number(version) !== workspace.version) throw new KnowledgeOperationError(409, 'stale_knowledge_review', 'Reload the changed workspace before publishing.');
	if (!review.commitSha || !((review.status === 'open' && workspace.status === 'submitted')
		|| (review.status === 'approved' && workspace.status === 'approved'))) {
		throw new KnowledgeOperationError(409, 'knowledge_review_not_publishable', 'Only an unchanged submitted revision can be published.');
	}
	const [diff, status] = await Promise.all([
		connection.client.diff({ workspaceId: workspace.treeDxWorkspaceId }),
		connection.client.status({ workspaceId: workspace.treeDxWorkspaceId }),
	]);
	const paths = (value: unknown) => Array.isArray(value) ? [...value].map(String).sort().join('\n') : '';
	if (!paths(review.changedPaths) || paths(review.changedPaths) !== paths(diff.changedPaths)
		|| status.commitSha !== review.commitSha || (status.changes ?? []).length > 0) {
		throw new KnowledgeOperationError(409, 'knowledge_review_diff_changed', 'The workspace no longer matches its submitted commit.');
	}
	if (review.status === 'approved') return;
	const admitted = await store.decideKnowledgeReview(review.id, { decision: 'approve', decidedByUserId: principalId,
		notes: 'Exact revision admitted for staging publication; no human approval required.',
		workspaceId: workspace.id, workspaceVersion: workspace.version });
	if (!admitted.ok) throw new KnowledgeOperationError(409, 'stale_knowledge_review', 'The submitted revision changed during admission.');
	await store.recordAuditEvent({ eventType: 'knowledge.staging_release.admitted', actorType: 'user', actorId: principalId,
		targetType: 'knowledge_review', targetId: review.id, data: { workspaceId: workspace.id, projectId: workspace.projectId, commitSha: review.commitSha } });
}
