import type { TreeDxProxyAccessRequest,TreeDxProxyAccessResult } from '@treeseed/sdk/agent-capacity';
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function globLikePathMatches(pattern: string, candidate: string): boolean {
	const normalizedPattern = pattern.replace(/^\/+/, '');
	const normalizedCandidate = candidate.replace(/^\/+/, '');
	if (!normalizedPattern || normalizedPattern === '**' || normalizedPattern === '*') return true;
	if (normalizedPattern.endsWith('/**')) {
		const prefix = normalizedPattern.slice(0, -3);
		return normalizedCandidate === prefix || normalizedCandidate.startsWith(`${prefix}/`);
	}
	if (normalizedPattern.endsWith('*')) {
		return normalizedCandidate.startsWith(normalizedPattern.slice(0, -1));
	}
	return normalizedCandidate === normalizedPattern || normalizedCandidate.startsWith(`${normalizedPattern}/`);
}

export function treeDxProxyAuthorizedPathPatterns(handle: TreeDxProxyHandle | Record<string, unknown> | null | undefined, operation?: string | null) {
	const candidate = record(handle); const writeOperation = operation === 'files:write' || operation === 'git:commit';
	const readPaths = Array.isArray(candidate.allowedReadPaths) ? candidate.allowedReadPaths.map(String).filter(Boolean) : [];
	const writePaths = Array.isArray(candidate.allowedWritePaths) ? candidate.allowedWritePaths.map(String).filter(Boolean) : [];
	const fallbackPaths = Array.isArray(candidate.allowedPaths) ? candidate.allowedPaths.map(String).filter(Boolean) : [];
	const paths = writeOperation ? (writePaths.length ? writePaths : fallbackPaths) : (readPaths.length ? readPaths : fallbackPaths);
	return paths.some((path) => path === '**' || path === '*') ? ['**'] : [...new Set(paths)];
}

export function evaluateTreeDxProxyHandleAccess(handle: TreeDxProxyHandle | Record<string, unknown> | null | undefined, request: TreeDxProxyAccessRequest): TreeDxProxyAccessResult {
	const candidate = record(handle);
	if (!candidate.id) return { ok: false, code: 'treedx_proxy_handle_missing', reason: 'TreeDX proxy handle is required.' };
	if (candidate.status === 'revoked' || candidate.revokedAt) return { ok: false, code: 'treedx_proxy_handle_revoked', reason: 'TreeDX proxy handle has been revoked.' };
	if (candidate.status === 'expired') return { ok: false, code: 'treedx_proxy_handle_expired', reason: 'TreeDX proxy handle has expired.' };
	if (String(candidate.projectId ?? '') !== request.projectId || (request.teamId && String(candidate.teamId ?? '') !== request.teamId)) {
		return { ok: false, code: 'treedx_proxy_scope_mismatch', reason: 'TreeDX proxy handle scope does not match the project.', metadata: { projectId: request.projectId, handleProjectId: candidate.projectId } };
	}
	if (request.assignmentId && candidate.assignmentId && String(candidate.assignmentId) !== request.assignmentId) {
		return { ok: false, code: 'treedx_proxy_assignment_mismatch', reason: 'TreeDX proxy handle is bound to a different assignment.', metadata: { assignmentId: request.assignmentId, handleAssignmentId: candidate.assignmentId } };
	}
	if (request.repositoryId && candidate.repositoryId && String(candidate.repositoryId) !== request.repositoryId) {
		return { ok: false, code: 'treedx_proxy_repository_mismatch', reason: 'TreeDX proxy handle is bound to a different repository.', metadata: { repositoryId: request.repositoryId, handleRepositoryId: candidate.repositoryId } };
	}
	if (request.workspaceId && candidate.workspaceId && String(candidate.workspaceId) !== request.workspaceId) {
		return { ok: false, code: 'treedx_proxy_workspace_mismatch', reason: 'TreeDX proxy handle is bound to a different workspace.', metadata: { workspaceId: request.workspaceId, handleWorkspaceId: candidate.workspaceId } };
	}
	if (candidate.expiresAt && Date.parse(String(candidate.expiresAt)) <= (request.now ?? new Date()).getTime()) {
		return { ok: false, code: 'treedx_proxy_handle_expired', reason: 'TreeDX proxy handle has expired.' };
	}
	if (candidate.token && request.token && String(candidate.token) !== request.token) {
		return { ok: false, code: 'treedx_proxy_token_mismatch', reason: 'TreeDX proxy handle token does not match.' };
	}
	const operation = request.operation ? String(request.operation) : null;
	const allowedOperations = Array.isArray(candidate.allowedOperations) ? candidate.allowedOperations.map(String) : [];
	if (operation && allowedOperations.length && !allowedOperations.includes(operation) && !allowedOperations.includes('*')) {
		return { ok: false, code: 'treedx_proxy_operation_denied', reason: 'TreeDX proxy handle does not allow this operation.', metadata: { operation, allowedOperations } };
	}
	const path = request.path ? String(request.path).replace(/^\/+/, '') : null;
	const allowedPaths = treeDxProxyAuthorizedPathPatterns(candidate, operation);
	if (path && allowedPaths.length && !allowedPaths.some((pattern) => globLikePathMatches(pattern, path))) {
		return { ok: false, code: 'treedx_proxy_path_denied', reason: 'TreeDX proxy handle does not allow this path.', metadata: { path, allowedPaths } };
	}
	return { ok: true };
}
