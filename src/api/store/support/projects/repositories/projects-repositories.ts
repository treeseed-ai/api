import { parseJson } from '../../foundation.ts';

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
    return [repository.provider ?? 'git', repository.owner ?? 'local', repository.name ?? 'repository']
        .join('-')
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/gu, '-')
        .replace(/^-+|-+$/gu, '') || 'repository';
}

export function platformRepositoryWorkspacePath(workspaceRoot, repository: any = {}) {
    const root = String(workspaceRoot ?? '/data').replace(/\/+$/u, '') || '/data';
    return `${root}/repositories/${platformRepositoryKey(repository)}/repo`;
}
