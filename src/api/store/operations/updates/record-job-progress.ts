import { isoNow,ControlPlaneStore } from "../../../persistence/store.ts";
export async function recordJobProgressMethod(this: ControlPlaneStore, jobId, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    await this.run(`UPDATE remote_jobs
			 SET status = CASE WHEN status IN ('pending', 'claimed', 'waiting_for_approval') THEN 'running' ELSE status END,
			     updated_at = ?
			 WHERE id = ?`, [timestamp, jobId]);
    await this.appendJobEvent(jobId, 'progress', {
        summary: input.summary ?? null,
        ...(input.data ?? {}),
    });
    return this.findJobById(jobId);
}
