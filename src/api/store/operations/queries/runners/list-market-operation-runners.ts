import { MarketControlPlaneStore,serializeMarketOperationRunner } from "../../../../persistence/store.ts";
export async function listMarketOperationRunnersMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const limit = Math.max(1, Math.min(Number(input.limit ?? 20) || 20, 100));
    const rows = await this.all(`SELECT * FROM market_operation_runners ORDER BY heartbeat_at DESC, updated_at DESC LIMIT ?`, [limit]);
    return rows.map(serializeMarketOperationRunner);
}
