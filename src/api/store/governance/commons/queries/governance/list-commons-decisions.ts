import { MarketControlPlaneStore,serializeCommonsDecision } from "../../../../../persistence/store.ts";
export async function listCommonsDecisionsMethod(this: MarketControlPlaneStore, filters: any = {}) {
    await this.ensureInitialized();
    const limit = Math.max(1, Math.min(200, Number(filters.limit) || 100));
    const rows = await this.all(`SELECT * FROM commons_decisions ORDER BY updated_at DESC LIMIT ?`, [limit]);
    return rows.map(serializeCommonsDecision);
}
