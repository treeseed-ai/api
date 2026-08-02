import { MarketControlPlaneStore,serializeCatalogItem } from "../../../../../persistence/store.ts";
export async function getCatalogItemMethod(this: MarketControlPlaneStore, itemId) {
    await this.ensureInitialized();
    return serializeCatalogItem(await this.first(`SELECT * FROM catalog_items WHERE id = ?`, [itemId]));
}
