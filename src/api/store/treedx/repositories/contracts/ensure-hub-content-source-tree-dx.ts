import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,serializeHubContentSource } from "../../../../persistence/store.ts";
export async function ensureHubContentSourceTreeDxMethod(this: MarketControlPlaneStore, projectId, teamId, contentRepositoryId, topology) {
    const timestamp = isoNow();
    const existing = serializeHubContentSource(await this.first(`SELECT * FROM hub_content_sources WHERE hub_id = ? LIMIT 1`, [projectId]));
    const r2 = topology?.contentRepository?.r2 ?? {};
    if (existing) {
        await this.run(`UPDATE hub_content_sources
				 SET content_repository_id = ?, production_source = ?, overlay_policy = ?, r2_bucket_name = ?, r2_manifest_key = ?, metadata_json = ?, updated_at = ?
				 WHERE hub_id = ?`, [
            contentRepositoryId,
            'treedx',
            existing.overlayPolicy ?? 'treedx_snapshot',
            r2.bucketName ?? existing.r2BucketName ?? null,
            r2.manifestKey ?? existing.r2ManifestKey ?? null,
            JSON.stringify({
                ...(existing.metadata ?? {}),
                contentCanonical: 'treedx',
                publishSource: 'treedx_to_r2',
                treeDxRepositoryBinding: topology,
            }),
            timestamp,
            projectId,
        ]);
    }
    else {
        await this.run(`INSERT INTO hub_content_sources (
					id, hub_id, team_id, content_repository_id, production_source, overlay_policy, r2_bucket_name,
					r2_manifest_key, r2_public_base_url, latest_publish_id, latest_content_version, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            randomUUID(),
            projectId,
            teamId,
            contentRepositoryId,
            'treedx',
            'treedx_snapshot',
            r2.bucketName ?? null,
            r2.manifestKey ?? null,
            r2.publicBaseUrl ?? null,
            null,
            null,
            JSON.stringify({
                contentCanonical: 'treedx',
                publishSource: 'treedx_to_r2',
                treeDxRepositoryBinding: topology,
            }),
            timestamp,
            timestamp,
        ]);
    }
}
