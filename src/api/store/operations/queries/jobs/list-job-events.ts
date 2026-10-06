import { ControlPlaneStore,serializeJobEvent } from "../../../../persistence/store.ts";
import type { JobEventRow } from "../../../support/operations/operations.ts";
export async function listJobEventsMethod(this: ControlPlaneStore, jobId: string) {
    await this.ensureInitialized();
    const rows = await this.all<JobEventRow>(`SELECT * FROM remote_job_events WHERE job_id = ? ORDER BY seq ASC`, [jobId]);
    return rows.map(serializeJobEvent);
}
