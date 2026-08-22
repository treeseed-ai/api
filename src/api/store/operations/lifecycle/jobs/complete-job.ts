import { isoNow,ControlPlaneStore } from "../../../../persistence/store.ts";
export async function completeJobMethod(this: ControlPlaneStore, jobId, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    await this.run(`UPDATE remote_jobs
			 SET status = 'completed',
			     output_json = ?,
			     error_json = NULL,
			     finished_at = ?,
			     updated_at = ?
			 WHERE id = ?`, [JSON.stringify(input.output ?? null), timestamp, timestamp, jobId]);
    await this.appendJobEvent(jobId, 'completed', {});
    return this.findJobById(jobId);
}
