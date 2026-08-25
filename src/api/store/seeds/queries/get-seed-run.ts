import { ControlPlaneStore,serializeSeedRun } from "../../../persistence/store.ts";
export async function getSeedRunMethod(this: ControlPlaneStore, id) {
    await this.ensureInitialized();
    return serializeSeedRun(await this.first(`SELECT * FROM seed_runs WHERE id = ? LIMIT 1`, [id]));
}
