import { MarketControlPlaneStore,serializeCommerceServiceContract } from "../../../../persistence/store.ts";
export async function getCommerceServiceContractMethod(this: MarketControlPlaneStore, contractId) {
    await this.ensureInitialized();
    return serializeCommerceServiceContract(await this.first(`SELECT * FROM commerce_service_contracts WHERE id = ? LIMIT 1`, [contractId]));
}
