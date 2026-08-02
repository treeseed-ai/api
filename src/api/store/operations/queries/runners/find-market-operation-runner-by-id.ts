import { MarketControlPlaneStore,serializeMarketOperationRunner } from "../../../../persistence/store.ts";
export async function findMarketOperationRunnerByIdMethod(this: MarketControlPlaneStore, runnerId) {
    await this.ensureInitialized();
    return serializeMarketOperationRunner(await this.first(`SELECT * FROM market_operation_runners WHERE id = ?`, [runnerId]));
}
