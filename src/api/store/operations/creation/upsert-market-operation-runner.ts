import { isoNow,ControlPlaneStore,serializeMarketOperationRunner } from "../../../persistence/store.ts";
export async function upsertMarketOperationRunnerMethod(this: ControlPlaneStore, input) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.runnerId ?? input.id;
    const runnerKey = input.runnerKey ?? id;
    await this.run(`INSERT INTO control_plane_operation_runners (
				id, runner_key, name, environment, status, version, capabilities_json,
				active_job_count, max_concurrent_jobs, heartbeat_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				runner_key = excluded.runner_key,
				name = excluded.name,
				environment = excluded.environment,
				status = excluded.status,
				version = excluded.version,
				capabilities_json = excluded.capabilities_json,
				active_job_count = excluded.active_job_count,
				max_concurrent_jobs = excluded.max_concurrent_jobs,
				heartbeat_at = excluded.heartbeat_at,
				metadata_json = excluded.metadata_json,
				updated_at = excluded.updated_at`, [
        id,
        runnerKey,
        input.name ?? id,
        input.environment ?? 'unknown',
        input.status ?? 'online',
        input.version ?? null,
        JSON.stringify(Array.isArray(input.capabilities) ? input.capabilities : []),
        Math.max(0, Number(input.activeJobCount ?? 0) || 0),
        Math.max(1, Number(input.maxConcurrentJobs ?? 1) || 1),
        input.heartbeatAt ?? timestamp,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    return serializeMarketOperationRunner(await this.first(`SELECT * FROM control_plane_operation_runners WHERE id = ?`, [id]));
}
