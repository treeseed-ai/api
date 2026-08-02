import { MarketControlPlaneStore,serializeSeedRun } from "../../../persistence/store.ts";
export async function listSeedRunsMethod(this: MarketControlPlaneStore, limit = 50) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM seed_runs ORDER BY created_at DESC LIMIT ?`, [Math.max(1, Math.min(200, Number(limit) || 50))]);
    return rows.map(serializeSeedRun);
}
