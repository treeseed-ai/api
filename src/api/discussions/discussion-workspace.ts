import { createHash, randomUUID } from 'node:crypto';
import { treeDxWorkspaceId } from '../knowledge/workspaces/identity.ts';
import {
	listOpenTreeDxWorkspaces,
	recordTreeDxWorkspaceState,
} from '../capacity/services/treedx/repositories/treedx-authoring-journal.ts';

type WorkspaceConnection = {
	repositoryId: string;
	allowedPaths: string[];
	client: {
		createWorkspace(input: Record<string, unknown>): Promise<any>;
		closeWorkspace(workspaceId: string): Promise<void>;
	};
};

type WorkspaceStore = Parameters<typeof recordTreeDxWorkspaceState>[0];

export function discussionWorkspaceOperationKey(kind: string, identity: string) {
	return `${kind}:${createHash('sha256').update(identity).digest('hex')}`;
}

export async function openDiscussionWorkspace(input: {
	store: WorkspaceStore;
	connection: WorkspaceConnection;
	projectId: string;
	baseRef: string;
	branchName: string;
	operationKey: string;
}) {
	const prior = await listOpenTreeDxWorkspaces(input.store, {
		projectId: input.projectId,
		repositoryId: input.connection.repositoryId,
		operationKey: input.operationKey,
	});
	for (const attempt of prior) {
		const age = Date.now() - Date.parse(attempt.createdAt);
		if (!Number.isFinite(age) || age < 60_000) {
			throw Object.assign(new Error('The same Discussion authoring operation is already active.'), {
				status: 409, code: 'discussion_authoring_active',
				details: { operationKey: input.operationKey, workspaceId: attempt.workspaceId },
			});
		}
		await input.connection.client.closeWorkspace(attempt.workspaceId).catch((error: unknown) => {
			const status = Number((error as { status?: unknown })?.status ?? 0);
			if (status !== 404) throw error;
		});
		await recordTreeDxWorkspaceState(input.store,'closed',{
			projectId:input.projectId,repositoryId:input.connection.repositoryId,
			workspaceId:attempt.workspaceId,operationKey:input.operationKey,ref:input.branchName,
			actorType:'service',actorId:'discussion-authoring-recovery',
		});
	}
	const workspaceId=treeDxWorkspaceId(randomUUID());
	await recordTreeDxWorkspaceState(input.store,'open',{
		projectId:input.projectId,repositoryId:input.connection.repositoryId,
		workspaceId,operationKey:input.operationKey,ref:input.branchName,
		actorType:'service',actorId:'discussion-authoring',
	});
	try {
		const workspace=await input.connection.client.createWorkspace({
			workspaceId,repoId:input.connection.repositoryId,baseRef:input.baseRef,
			branchName:input.branchName,mode:'writable',allowedPaths:input.connection.allowedPaths,ttlSeconds:600,
		});
		return { workspace, async close() {
			await input.connection.client.closeWorkspace(workspaceId);
			await recordTreeDxWorkspaceState(input.store,'closed',{
				projectId:input.projectId,repositoryId:input.connection.repositoryId,
				workspaceId,operationKey:input.operationKey,ref:input.branchName,
				actorType:'service',actorId:'discussion-authoring',
			});
		} };
	} catch (error) {
		await recordTreeDxWorkspaceState(input.store,'closed',{
			projectId:input.projectId,repositoryId:input.connection.repositoryId,
			workspaceId,operationKey:input.operationKey,ref:input.branchName,
			actorType:'service',actorId:'discussion-authoring',
		});
		throw error;
	}
}
