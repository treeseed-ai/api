import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,serializeCatalogItem } from "../../../../persistence/store.ts";
export async function upsertCatalogItemMethod(this: MarketControlPlaneStore, teamId, input) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const existing = await this.first(`SELECT * FROM catalog_items WHERE id = ?`, [id]);
    if (existing) {
        await this.run(`UPDATE catalog_items
				 SET team_id = ?, kind = ?, slug = ?, title = ?, summary = ?, visibility = ?, listing_enabled = ?, offer_mode = ?, manifest_key = ?, artifact_key = ?, search_text = ?, metadata_json = ?, updated_at = ?
				 WHERE id = ?`, [
            teamId,
            input.kind,
            input.slug,
            input.title,
            input.summary ?? null,
            input.visibility ?? 'private',
            input.listingEnabled === true ? 1 : 0,
            input.offerMode ?? 'private',
            input.manifestKey ?? null,
            input.artifactKey ?? null,
            input.searchText ?? null,
            JSON.stringify(input.metadata ?? {}),
            timestamp,
            id,
        ]);
    }
    else {
        await this.run(`INSERT INTO catalog_items (
					id, team_id, kind, slug, title, summary, visibility, listing_enabled, offer_mode, manifest_key, artifact_key, search_text, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            id,
            teamId,
            input.kind,
            input.slug,
            input.title,
            input.summary ?? null,
            input.visibility ?? 'private',
            input.listingEnabled === true ? 1 : 0,
            input.offerMode ?? 'private',
            input.manifestKey ?? null,
            input.artifactKey ?? null,
            input.searchText ?? null,
            JSON.stringify(input.metadata ?? {}),
            timestamp,
            timestamp,
        ]);
    }
    return serializeCatalogItem(await this.first(`SELECT * FROM catalog_items WHERE id = ?`, [id]));
}
