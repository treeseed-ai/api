import { ControlPlaneStore,serializeSeedRun } from "../../../persistence/store.ts";
import type { SeedRunRow } from '../../support/foundation.ts';
export async function getSeedRunMethod(this: ControlPlaneStore, id: string) {
    await this.ensureInitialized();
    return serializeSeedRun(await this.first<SeedRunRow>(`SELECT * FROM seed_runs WHERE id = ? LIMIT 1`, [id]));
}
