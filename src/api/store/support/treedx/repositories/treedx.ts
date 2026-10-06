import { redactSensitiveValue } from '../../../../../security/redact-sensitive-value.ts';
import { normalizeBaseUrl,parseJson } from '../../index.ts';

export type TreeDxInstanceRow = {
    id: string; team_id: string; kind: string; provider: string; name: string;
    base_url: string | null; registry_url: string | null; public_read: number; primary: number;
    status: string; image_ref: string | null; railway_project_id: string | null;
    railway_service_id: string | null; railway_environment_id: string | null;
    volume_mount_path: string | null; metadata_json: string; created_at: string; updated_at: string;
};
export type TreeDxProjectLibraryRow = {
    id: string; team_id: string; project_id: string; instance_id: string; library_id: string;
    repository_id: string | null; content_path: string; content_repository_url: string | null;
    content_repository_default_branch: string | null; content_repository_ref: string | null;
    r2_bucket_name: string | null; r2_manifest_key: string | null; topology_json: string;
    metadata_json: string; created_at: string; updated_at: string;
};
export type TreeDxMirrorRow = {
    id: string; team_id: string; instance_id: string; name: string; direction: string; target_kind: string;
    target_url: string | null; status: string; instructions: string | null; last_sync_at: string | null;
    last_sync_status: string | null; last_sync_metadata_json: string; metadata_json: string;
    created_at: string; updated_at: string;
};
export type TreeDxShareRow = {
    id: string; team_id: string; instance_id: string | null; project_id: string | null;
    library_id: string | null; scope: string; target_team_id: string | null; trust_grant_json: string;
    public_read: number; status: string; expires_at: string | null; metadata_json: string;
    created_at: string; updated_at: string; revoked_at: string | null;
};
export type TreeDxDeploymentRow = {
    id: string; team_id: string; instance_id: string | null; provider: string; status: string;
    image_ref: string | null; volume_mount_path: string | null; service_refs_json: string;
    result_json: string; error_json: string | null; created_at: string; updated_at: string;
    completed_at: string | null;
};

export function centralTreeDxRegistryUrl(config: any = {}) {
    return normalizeBaseUrl(process.env.TREESEED_PUBLIC_TREEDX_REGISTRY_URL
        ?? process.env.TREESEED_CENTRAL_TREEDX_REGISTRY_URL
        ?? config.publicTreeDxRegistryUrl
        ?? config.treedxRegistryUrl
        ?? 'https://api.treeseed.dev/treedx');
}

export function serializeTreeDxInstance(row: TreeDxInstanceRow | null | undefined) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        kind: row.kind,
        provider: row.provider,
        name: row.name,
        baseUrl: row.base_url,
        registryUrl: row.registry_url,
        publicRead: Boolean(row.public_read),
        primary: Boolean(row.primary),
        status: row.status,
        imageRef: row.image_ref,
        railwayProjectId: row.railway_project_id,
        railwayServiceId: row.railway_service_id,
        railwayEnvironmentId: row.railway_environment_id,
        volumeMountPath: row.volume_mount_path,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeTreeDxProjectLibrary(row: TreeDxProjectLibraryRow | null | undefined) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id,
        instanceId: row.instance_id,
        libraryId: row.library_id,
        repositoryId: row.repository_id,
        contentPath: row.content_path,
        contentRepositoryUrl: row.content_repository_url,
        contentRepositoryDefaultBranch: row.content_repository_default_branch,
        contentRepositoryRef: row.content_repository_ref,
        r2BucketName: row.r2_bucket_name,
        r2ManifestKey: row.r2_manifest_key,
        topology: parseJson(row.topology_json, {}),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeTreeDxMirror(row: TreeDxMirrorRow | null | undefined) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        instanceId: row.instance_id,
        name: row.name,
        direction: row.direction,
        targetKind: row.target_kind,
        targetUrl: row.target_url,
        status: row.status,
        instructions: row.instructions,
        lastSyncAt: row.last_sync_at,
        lastSyncStatus: row.last_sync_status,
        lastSyncMetadata: parseJson(row.last_sync_metadata_json, {}),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeTreeDxShare(row: TreeDxShareRow | null | undefined) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        instanceId: row.instance_id,
        projectId: row.project_id,
        libraryId: row.library_id,
        scope: row.scope,
        targetTeamId: row.target_team_id,
        trustGrant: parseJson(row.trust_grant_json, {}),
        publicRead: Boolean(row.public_read),
        status: row.status,
        expiresAt: row.expires_at,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        revokedAt: row.revoked_at,
    };
}

export function serializeTreeDxDeployment(row: TreeDxDeploymentRow | null | undefined) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        instanceId: row.instance_id,
        provider: row.provider,
        status: row.status,
        imageRef: row.image_ref,
        volumeMountPath: row.volume_mount_path,
        serviceRefs: parseJson(row.service_refs_json, {}),
        result: parseJson(row.result_json, {}),
        error: parseJson(row.error_json, null),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
    };
}

export function serializeTreeDxCredentialIssuanceRecord(row: Record<string, unknown> | null | undefined) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id,
        assignmentId: row.assignment_id,
        repository: row.repository,
        credentialProvider: row.credential_provider,
        status: row.status,
        tokenPrefix: row.token_prefix,
        tokenHash: row.token_hash,
        scopes: parseJson(row.scopes_json, []),
        allowedOperations: parseJson(row.allowed_operations_json, []),
        expiresAt: row.expires_at,
        issuedAt: row.issued_at,
        revokedAt: row.revoked_at,
        failClosedCode: row.fail_closed_code,
        metadata: redactSensitiveValue(parseJson(row.metadata_json, {})),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
