import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore } from "../../../persistence/store.ts";
export async function createSeedRunMethod(this: ControlPlaneStore, input) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO seed_runs (
				id, seed_name, seed_version, environments_json, mode, state, actor_type, actor_id,
				manifest_hash, plan_json, result_json, error_json, created_at, updated_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.seedName,
        Number(input.seedVersion ?? input.version ?? 1),
        JSON.stringify(input.environments ?? []),
        input.mode ?? 'plan',
        input.state ?? 'running',
        input.actorType ?? null,
        input.actorId ?? null,
        input.manifestHash ?? '',
        JSON.stringify(input.plan ?? null),
        input.result === undefined ? null : JSON.stringify(input.result),
        input.error === undefined ? null : JSON.stringify(input.error),
        timestamp,
        timestamp,
        input.completedAt ?? null,
    ]);
    return this.getSeedRun(id);
}
