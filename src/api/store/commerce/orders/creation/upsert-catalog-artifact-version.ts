import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,serializeCatalogArtifactVersion } from "../../../../persistence/store.ts";
export async function upsertCatalogArtifactVersionMethod(this: MarketControlPlaneStore, teamId, itemId, input) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const existing = await this.first(`SELECT * FROM catalog_artifact_versions WHERE item_id = ? AND version = ? LIMIT 1`, [itemId, input.version]);
    if (existing) {
        await this.run(`UPDATE catalog_artifact_versions
				 SET team_id = ?, kind = ?, content_key = ?, manifest_key = ?, metadata_json = ?, published_at = ?, updated_at = ?
				 WHERE id = ?`, [
            teamId,
            input.kind,
            input.contentKey,
            input.manifestKey ?? null,
            JSON.stringify(input.metadata ?? {}),
            input.publishedAt ?? timestamp,
            timestamp,
            existing.id,
        ]);
        return serializeCatalogArtifactVersion(await this.first(`SELECT * FROM catalog_artifact_versions WHERE id = ?`, [existing.id]));
    }
    await this.run(`INSERT INTO catalog_artifact_versions (
				id, item_id, team_id, kind, version, content_key, manifest_key, metadata_json, published_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        itemId,
        teamId,
        input.kind,
        input.version,
        input.contentKey,
        input.manifestKey ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.publishedAt ?? timestamp,
        timestamp,
        timestamp,
    ]);
    return serializeCatalogArtifactVersion(await this.first(`SELECT * FROM catalog_artifact_versions WHERE id = ?`, [id]));
}
