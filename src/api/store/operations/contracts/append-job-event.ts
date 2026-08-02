import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,serializeJobEvent } from "../../../persistence/store.ts";
export async function appendJobEventMethod(this: MarketControlPlaneStore, jobId, kind, data: any = {}) {
    await this.ensureInitialized();
    const row = await this.first(`SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM remote_job_events WHERE job_id = ?`, [jobId]);
    const seq = Number(row?.next_seq ?? 1);
    const timestamp = isoNow();
    const id = randomUUID();
    await this.run(`INSERT INTO remote_job_events (id, job_id, seq, kind, data_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`, [id, jobId, seq, kind, JSON.stringify(data), timestamp]);
    return serializeJobEvent(await this.first(`SELECT * FROM remote_job_events WHERE id = ?`, [id]));
}
