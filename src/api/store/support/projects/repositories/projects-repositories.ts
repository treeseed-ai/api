import { parseJson } from '../../foundation.ts';
import { resolveRepositoryIdentity } from '@treeseed/sdk';

export function serializeHubRepository(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        hubId: row.hub_id,
        teamId: row.team_id,
        role: row.role,
        provider: row.provider,
        owner: row.owner,
        name: row.name,
        url: row.url,
        defaultBranch: row.default_branch,
        currentBranch: row.current_branch,
        status: row.status,
        accessPolicy: parseJson(row.access_policy_json, {}),
        releasePolicy: parseJson(row.release_policy_json, {}),
        publishPolicy: parseJson(row.publish_policy_json, {}),
        submodulePath: row.submodule_path,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializePlatformRepositoryClaim(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        repositoryKey: row.repository_key,
        runnerId: row.runner_id,
        workspacePath: row.workspace_path,
        branch: row.branch,
        commitSha: row.commit_sha,
        claimState: row.claim_state,
        leaseExpiresAt: row.lease_expires_at,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function platformRepositoryKey(repository: any = {}) {
	if (typeof repository.cloneUrl === 'string' && repository.cloneUrl.trim()) {
		return resolveRepositoryIdentity(repository.cloneUrl).canonicalKey;
	}
    return [repository.provider ?? 'git', repository.owner ?? 'local', repository.name ?? 'repository']
        .join('-')
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/gu, '-')
        .replace(/^-+|-+$/gu, '') || 'repository';
}

export function platformRepositoryWorkspacePath(workspaceRoot, repository: any = {}, operationId?: string) {
    const root = String(workspaceRoot ?? '/data').replace(/\/+$/u, '') || '/data';
	if (operationId) {
		const safeOperationId = operationId.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '');
		if (!safeOperationId) throw new Error('Platform repository operation id is invalid.');
		return `${root}/operations/${safeOperationId}/checkout`;
	}
	const storageKey = platformRepositoryKey(repository).replace(/[^a-z0-9.-]+/giu, '-').toLowerCase();
	return `${root}/repositories/${storageKey}/repo`;
}
