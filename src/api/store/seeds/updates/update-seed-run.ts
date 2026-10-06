import { isoNow,ControlPlaneStore } from "../../../persistence/store.ts";
export async function updateSeedRunMethod(this: ControlPlaneStore, id: string, input: Record<string, unknown>) {
    await this.ensureInitialized();
    const existing = await this.getSeedRun(id);
    if (!existing)
        return null;
    const timestamp = isoNow();
    const terminalStates: readonly unknown[] = ['completed', 'failed', 'blocked', 'partial'];
    await this.run(`UPDATE seed_runs
			 SET state = ?, result_json = ?, error_json = ?, updated_at = ?, completed_at = ?
			 WHERE id = ?`, [
        input.state ?? existing.state,
        input.result === undefined ? JSON.stringify(existing.result ?? null) : JSON.stringify(input.result),
        input.error === undefined ? JSON.stringify(existing.error ?? null) : JSON.stringify(input.error),
        timestamp,
        input.completedAt ?? (terminalStates.includes(input.state) ? timestamp : existing.completedAt),
        id,
    ]);
    return this.getSeedRun(id);
}
