import { parseJson } from '../../foundation.ts';

// Columns of the existing hub_repositories table, not a new repository model.
export interface HubRepositoryRow extends Record<string, unknown> {
    id: string;
    hub_id: string;
    team_id: string;
    role: string;
    provider: string;
    owner: string;
    name: string;
    url: string | null;
    default_branch: string | null;
    current_branch: string | null;
    status: string;
    access_policy_json: string;
    release_policy_json: string;
    publish_policy_json: string;
    submodule_path: string | null;
    metadata_json: string;
    created_at: string;
    updated_at: string;
}

type SerializedHubRepository = Pick<HubRepositoryRow, 'id' | 'role' | 'provider' | 'owner' | 'name' | 'url' | 'status'> & {
    hubId: string;
    teamId: string;
    defaultBranch: string | null;
    currentBranch: string | null;
    submodulePath: string | null;
    accessPolicy: ReturnType<typeof parseJson>;
    releasePolicy: ReturnType<typeof parseJson>;
    publishPolicy: ReturnType<typeof parseJson>;
    metadata: ReturnType<typeof parseJson>;
    createdAt: string;
    updatedAt: string;
};

export function serializeHubRepository(row: HubRepositoryRow): SerializedHubRepository;
export function serializeHubRepository(row: null | undefined): null;
export function serializeHubRepository(row: HubRepositoryRow | null | undefined): SerializedHubRepository | null;
export function serializeHubRepository(row: HubRepositoryRow | null | undefined) {
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
