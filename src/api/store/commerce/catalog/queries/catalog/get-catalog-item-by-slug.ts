import { MarketControlPlaneStore,serializeCatalogItem } from "../../../../../persistence/store.ts";
export async function getCatalogItemBySlugMethod(this: MarketControlPlaneStore, kind, slug) {
    await this.ensureInitialized();
    return serializeCatalogItem(await this.first(`SELECT * FROM catalog_items WHERE kind = ? AND slug = ? LIMIT 1`, [kind, slug]));
}
