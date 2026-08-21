import { isoNow,ControlPlaneStore } from "../../../persistence/store.ts";
export async function cancelJobMethod(this: ControlPlaneStore, jobId) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    await this.run(`UPDATE remote_jobs
			 SET status = CASE
			 	WHEN status IN ('completed', 'failed', 'cancelled') THEN status
			 	ELSE 'cancelled'
			 END,
			     cancelled_at = CASE
			     	WHEN status IN ('completed', 'failed', 'cancelled') THEN cancelled_at
			     	ELSE ?
			     END,
			     updated_at = ?
			 WHERE id = ?`, [timestamp, timestamp, jobId]);
    await this.appendJobEvent(jobId, 'cancelled', {});
    return this.findJobById(jobId);
}
