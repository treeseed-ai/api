import { MarketControlPlaneStore,serializeCommerceServiceRequest } from "../../../../persistence/store.ts";
export async function getCommerceServiceRequestMethod(this: MarketControlPlaneStore, requestId) {
    await this.ensureInitialized();
    return serializeCommerceServiceRequest(await this.first(`SELECT * FROM commerce_service_requests WHERE id = ? LIMIT 1`, [requestId]));
}
