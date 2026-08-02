import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,serializeHubContentSource } from "../../../persistence/store.ts";
export async function upsertHubContentSourceMethod(this: MarketControlPlaneStore, hubId, input) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const project = await this.getProject(hubId);
    const teamId = input.teamId ?? project?.teamId;
    if (!teamId)
        throw new Error('teamId is required for hub content source records.');
    const existing = await this.first(`SELECT * FROM hub_content_sources WHERE hub_id = ? LIMIT 1`, [hubId]);
    const payload = [
        teamId,
        input.contentRepositoryId ?? null,
        input.productionSource ?? 'r2_published_artifacts',
        input.overlayPolicy ?? 'src_content_when_present',
        input.r2BucketName ?? null,
        input.r2ManifestKey ?? null,
        input.r2PublicBaseUrl ?? null,
        input.latestPublishId ?? null,
        input.latestContentVersion ?? null,
        JSON.stringify(input.metadata ?? {}),
    ];
    if (existing) {
        await this.run(`UPDATE hub_content_sources
				 SET team_id = ?, content_repository_id = ?, production_source = ?, overlay_policy = ?, r2_bucket_name = ?,
				     r2_manifest_key = ?, r2_public_base_url = ?, latest_publish_id = ?, latest_content_version = ?,
				     metadata_json = ?, updated_at = ?
				 WHERE hub_id = ?`, [...payload, timestamp, hubId]);
        return serializeHubContentSource(await this.first(`SELECT * FROM hub_content_sources WHERE hub_id = ?`, [hubId]));
    }
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO hub_content_sources (
				id, hub_id, team_id, content_repository_id, production_source, overlay_policy, r2_bucket_name, r2_manifest_key,
				r2_public_base_url, latest_publish_id, latest_content_version, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, hubId, ...payload, timestamp, timestamp]);
    return serializeHubContentSource(await this.first(`SELECT * FROM hub_content_sources WHERE id = ?`, [id]));
}
