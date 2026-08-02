import { MarketControlPlaneStore,serializeCommerceServiceContract } from "../../../../persistence/store.ts";
export async function getCommerceServiceContractForRequestMethod(this: MarketControlPlaneStore, requestId) {
    await this.ensureInitialized();
    return serializeCommerceServiceContract(await this.first(`SELECT * FROM commerce_service_contracts WHERE request_id = ? LIMIT 1`, [requestId]));
}
