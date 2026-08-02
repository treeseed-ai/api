import { MarketControlPlaneStore,serializeCatalogArtifactVersion } from "../../../../persistence/store.ts";
export async function getCatalogArtifactVersionByIdMethod(this: MarketControlPlaneStore, artifactVersionId) {
    await this.ensureInitialized();
    return serializeCatalogArtifactVersion(await this.first(`SELECT * FROM catalog_artifact_versions WHERE id = ? LIMIT 1`, [artifactVersionId]));
}
