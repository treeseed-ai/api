import { MarketControlPlaneStore,serializeHubContentSource } from "../../../persistence/store.ts";
export async function getHubContentSourceMethod(this: MarketControlPlaneStore, hubId) {
    await this.ensureInitialized();
    return serializeHubContentSource(await this.first(`SELECT * FROM hub_content_sources WHERE hub_id = ?`, [hubId]));
}
