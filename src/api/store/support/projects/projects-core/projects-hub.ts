import { parseJson } from '../../foundation.ts';

export function serializeHubContentSource(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        hubId: row.hub_id,
        teamId: row.team_id,
        contentRepositoryId: row.content_repository_id,
        productionSource: row.production_source,
        overlayPolicy: row.overlay_policy,
        r2BucketName: row.r2_bucket_name,
        r2ManifestKey: row.r2_manifest_key,
        r2PublicBaseUrl: row.r2_public_base_url,
        latestPublishId: row.latest_publish_id,
        latestContentVersion: row.latest_content_version,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
