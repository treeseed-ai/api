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
