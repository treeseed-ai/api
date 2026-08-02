import type { KnowledgeGatewayConnection } from './gateway-treedx-connection.ts';

export interface RevisionWorkspace {
	workspaceId: string;
	baseRef: string;
	baseCommitSha: string;
	branchName: string;
}

export function reviewWorkspaceAvailable(reviewStatus: string, workspaceStatus: string): boolean {
	return (reviewStatus === 'open' && workspaceStatus === 'submitted')
		|| (reviewStatus === 'changes-requested' && workspaceStatus === 'changes-requested')
		|| (reviewStatus === 'approved' && workspaceStatus === 'approved');
}

export function currentReviewIds<T extends { id: string; workspaceId: string }>(reviews: T[]): Set<string> {
	const current = new Set<string>();
	const seenWorkspaces = new Set<string>();
	for (const review of reviews) {
		if (!seenWorkspaces.has(review.workspaceId)) current.add(review.id);
		seenWorkspaces.add(review.workspaceId);
	}
	return current;
}

export async function createRevisionWorkspace(connection: KnowledgeGatewayConnection, workspace: any,
	reviewCommitSha: string): Promise<RevisionWorkspace> {
	const remote = await connection.client.createWorkspace({
		repoId: connection.repositoryId,
		baseRef: workspace.branchName,
		branchName: workspace.branchName,
		mode: 'writable',
		allowedPaths: workspace.allowedPaths,
		ttlSeconds: 86_400,
	});
	if (remote.baseCommitSha !== reviewCommitSha) {
		await connection.client.closeWorkspace(remote.workspaceId).catch(() => undefined);
		throw new Error('The revision branch no longer matches the reviewed commit.');
	}
	return {
		workspaceId: remote.workspaceId,
		baseRef: remote.baseRef,
		baseCommitSha: remote.baseCommitSha,
		branchName: remote.branchName ?? workspace.branchName,
	};
}

export async function discardRevisionWorkspace(connection: KnowledgeGatewayConnection,
	revision: RevisionWorkspace | null): Promise<void> {
	if (revision) await connection.client.closeWorkspace(revision.workspaceId).catch(() => undefined);
}
