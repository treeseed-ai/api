import { isoNow,ControlPlaneStore } from "../../../../persistence/store.ts";
export async function retryJobMethod(this: ControlPlaneStore, jobId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.findJobById(jobId);
    if (!existing)
        return null;
    const timestamp = isoNow();
    const nextInput = {
        ...(existing.input ?? {}),
        ...(input.inputPatch && typeof input.inputPatch === 'object' ? input.inputPatch : {}),
    };
    await this.run(`UPDATE remote_jobs
			 SET status = ?,
			     input_json = ?,
			     output_json = NULL,
			     error_json = NULL,
			     assigned_runner_id = NULL,
			     updated_at = ?,
			     started_at = NULL,
			     finished_at = NULL,
			     cancelled_at = NULL
			 WHERE id = ?`, [
        input.status ?? 'pending',
        JSON.stringify(nextInput),
        timestamp,
        jobId,
    ]);
    await this.appendJobEvent(jobId, input.eventType ?? 'retry_queued', {
        status: input.status ?? 'pending',
        resume: nextInput.resume === true,
    });
    return this.findJobById(jobId);
}
