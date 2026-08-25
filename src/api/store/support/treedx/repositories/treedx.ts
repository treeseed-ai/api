import { redactSensitiveValue } from '../../../../../security/redact-sensitive-value.ts';
import { normalizeBaseUrl,parseJson } from '../../index.ts';

export function centralTreeDxRegistryUrl(config: any = {}) {
    return normalizeBaseUrl(process.env.TREESEED_PUBLIC_TREEDX_REGISTRY_URL
        ?? process.env.TREESEED_CENTRAL_TREEDX_REGISTRY_URL
        ?? config.publicTreeDxRegistryUrl
        ?? config.treedxRegistryUrl
        ?? 'https://api.treeseed.dev/treedx');
}

export function serializeTreeDxInstance(row) {
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

export function serializeTreeDxProjectLibrary(row) {
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

export function serializeTreeDxMirror(row) {
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

export function serializeTreeDxShare(row) {
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

export function serializeTreeDxDeployment(row) {
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

export function serializeTreeDxCredentialIssuanceRecord(row) {
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
