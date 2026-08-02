import { MarketControlPlaneStore,serializeJobEvent } from "../../../../persistence/store.ts";
export async function listJobEventsMethod(this: MarketControlPlaneStore, jobId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM remote_job_events WHERE job_id = ? ORDER BY seq ASC`, [jobId]);
    return rows.map(serializeJobEvent);
}
