import { MarketControlPlaneStore,serializeCatalogArtifactVersion } from "../../../../persistence/store.ts";
export async function getCatalogArtifactVersionMethod(this: MarketControlPlaneStore, itemId, version) {
    await this.ensureInitialized();
    const row = await this.first(`SELECT * FROM catalog_artifact_versions WHERE item_id = ? AND version = ? LIMIT 1`, [itemId, version]);
    return serializeCatalogArtifactVersion(row);
}
