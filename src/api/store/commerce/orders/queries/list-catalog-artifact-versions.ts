import { MarketControlPlaneStore,serializeCatalogArtifactVersion } from "../../../../persistence/store.ts";
export async function listCatalogArtifactVersionsMethod(this: MarketControlPlaneStore, itemId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM catalog_artifact_versions WHERE item_id = ? ORDER BY published_at DESC, created_at DESC`, [itemId]);
    return rows.map(serializeCatalogArtifactVersion);
}
