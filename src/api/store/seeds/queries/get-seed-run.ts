import { MarketControlPlaneStore,serializeSeedRun } from "../../../persistence/store.ts";
export async function getSeedRunMethod(this: MarketControlPlaneStore, id) {
    await this.ensureInitialized();
    return serializeSeedRun(await this.first(`SELECT * FROM seed_runs WHERE id = ? LIMIT 1`, [id]));
}
