import { randomUUID } from 'node:crypto';
import { resolveKnowledgeGatewayConnection } from '../../knowledge/gateway-treedx-connection.ts';
import { treeDxWorkspaceId } from '../../knowledge/workspace-identity.ts';
import { KnowledgeOperationError } from './knowledge-operation-error.ts';

type Principal = { id: string; roles?: string[]; permissions?: string[] } | undefined;

export function createKnowledgeWorkspaceService(store: any) {
	async function projectAccess(principal: Principal, projectId: string, permission: string) {
		if (!principal) throw new KnowledgeOperationError(401, 'authentication_required', 'Authentication is required.');
		const details = await store.getProjectDetails(projectId);
		if (!details?.project) throw new KnowledgeOperationError(404, 'project_not_found', 'The project was not found.');
		const administrator = principal.roles?.some((role) => ['admin', 'platform_admin'].includes(role))
			|| principal.permissions?.includes('*:*:*');
		if (!administrator && !await store.principalCanAccessTeam(principal, details.project.teamId)) {
			throw new KnowledgeOperationError(403, 'knowledge_access_denied', 'The principal cannot access this project.');
		}
		const access = administrator ? { permissions: ['*:*:*'] } : await store.getTeamAccessSummary(details.project.teamId, principal);
		if (!administrator && !access.permissions.includes(permission)) {
			throw new KnowledgeOperationError(403, 'knowledge_permission_denied', `${permission} authority is required.`);
		}
		return { principal, project: details.project };
	}

	async function workspaceAccess(principal: Principal, workspaceId: string, permission: string) {
		const workspace = await store.getKnowledgeWorkspace(workspaceId);
		if (!workspace) throw new KnowledgeOperationError(404, 'knowledge_workspace_not_found', 'Knowledge workspace not found.');
		let access;
		try { access = await projectAccess(principal, workspace.projectId, permission); }
		catch (error) {
			if (permission === 'knowledge:read') {
				try { access = await projectAccess(principal, workspace.projectId, 'knowledge:review'); }
				catch { throw new KnowledgeOperationError(404, 'knowledge_workspace_not_found', 'Knowledge workspace not found.'); }
			} else throw error;
		}
		if (permission === 'knowledge:read' && workspace.actorUserId !== access.principal.id) {
			await projectAccess(principal, workspace.projectId, 'knowledge:review');
		}
		return { ...access, workspace };
	}

	return {
		async create(principal: Principal, projectId: string, input: Record<string, unknown>) {
			const access = await projectAccess(principal, projectId, 'knowledge:author');
			const supplied = typeof input.requestId === 'string' ? input.requestId.trim() : '';
			const id = supplied || randomUUID();
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
				throw new KnowledgeOperationError(422, 'knowledge_request_id_invalid', 'A valid authoring request identifier is required.');
			}
			const existing = await store.getKnowledgeWorkspace(id);
			if (existing) {
				if (existing.projectId !== projectId || existing.actorUserId !== access.principal.id) {
					throw new KnowledgeOperationError(409, 'knowledge_request_id_conflict', 'This authoring request identifier is already in use.');
				}
				return existing;
			}
			const branchName = `refs/heads/knowledge/${id}`;
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId, write: true, workspaceRefs: [branchName] });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_repository_unavailable', 'The project knowledge repository is unavailable.');
			let remote;
			try {
				remote = await connection.client.createWorkspace({ workspaceId: treeDxWorkspaceId(id), repoId: connection.repositoryId,
					baseRef: connection.baseRef, branchName, mode: 'writable', allowedPaths: connection.allowedPaths, ttlSeconds: 86_400 });
			} catch { throw new KnowledgeOperationError(503, 'knowledge_workspace_unavailable', 'The project knowledge workspace could not be created.'); }
			const workspace = await store.createKnowledgeWorkspaceRecord({ id, teamId: access.project.teamId, projectId,
				repositoryId: connection.repositoryId, treeDxWorkspaceId: remote.workspaceId, actorUserId: access.principal.id,
				baseRef: remote.baseRef, baseCommitSha: remote.baseCommitSha, branchName: remote.branchName ?? branchName,
				allowedPaths: connection.allowedPaths });
			await store.recordAuditEvent({ id: `knowledge-workspace-created-${workspace.id}`, eventType: 'knowledge.workspace.created',
				actorType: 'user', actorId: access.principal.id, targetType: 'knowledge_workspace', targetId: workspace.id,
				data: { teamId: workspace.teamId, projectId, repositoryId: workspace.repositoryId } });
			return workspace;
		},

		async show(principal: Principal, workspaceId: string) {
			const access = await workspaceAccess(principal, workspaceId, 'knowledge:read');
			return { ...access.workspace, presence: await store.listKnowledgeWorkspacePresence(workspaceId) };
		},

		async diff(principal: Principal, workspaceId: string) {
			const access = await workspaceAccess(principal, workspaceId, 'knowledge:read');
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
				write: false, workspaceRefs: [access.workspace.branchName] });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_repository_unavailable', 'The project knowledge repository is unavailable.');
			return connection.client.diff({ workspaceId: access.workspace.treeDxWorkspaceId });
		},

		async abandon(principal: Principal, workspaceId: string, input: Record<string, unknown>) {
			const access = await workspaceAccess(principal, workspaceId, 'knowledge:author');
			if (access.workspace.actorUserId !== access.principal.id) throw new KnowledgeOperationError(403, 'knowledge_workspace_author_required', 'Only the workspace author can abandon this draft.');
			if (!['draft', 'changes-requested'].includes(access.workspace.status)) throw new KnowledgeOperationError(409, 'knowledge_workspace_locked', 'A submitted or published workspace cannot be abandoned.');
			if (Number(input.version) !== access.workspace.version) throw new KnowledgeOperationError(409, 'stale_workspace', 'The draft changed. Reload before abandoning it.');
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
				write: true, workspaceRefs: [access.workspace.branchName] });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_repository_unavailable', 'The project knowledge repository is unavailable.');
			await connection.client.closeWorkspace(access.workspace.treeDxWorkspaceId);
			const updated = await store.updateKnowledgeWorkspace(workspaceId, { version: access.workspace.version, status: 'abandoned' });
			if (!updated.ok) throw new KnowledgeOperationError(409, 'stale_workspace', 'The draft changed. Reload before abandoning it.');
			await store.recordAuditEvent({ eventType: 'knowledge.workspace.abandoned', actorType: 'user', actorId: access.principal.id,
				targetType: 'knowledge_workspace', targetId: workspaceId, data: { projectId: access.workspace.projectId } });
			return updated.workspace;
		},
	};
}
