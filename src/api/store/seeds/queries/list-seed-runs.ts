import { ControlPlaneStore,serializeSeedRun } from "../../../persistence/store.ts";
import type { SeedRunRow } from '../../support/foundation.ts';
export async function listSeedRunsMethod(this: ControlPlaneStore, limit: unknown = 50) {
    await this.ensureInitialized();
    const rows = await this.all<SeedRunRow>(`SELECT * FROM seed_runs ORDER BY created_at DESC LIMIT ?`, [Math.max(1, Math.min(200, Number(limit) || 50))]);
    return rows.map(row => serializeSeedRun(row));
}
