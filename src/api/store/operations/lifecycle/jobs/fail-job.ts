import { isoNow,ControlPlaneStore } from "../../../../persistence/store.ts";
export async function failJobMethod(this: ControlPlaneStore, jobId, input) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    await this.run(`UPDATE remote_jobs
			 SET status = 'failed',
			     error_json = ?,
			     finished_at = ?,
			     updated_at = ?
			 WHERE id = ?`, [JSON.stringify({ code: input.code ?? null, message: input.message }), timestamp, timestamp, jobId]);
    await this.appendJobEvent(jobId, 'failed', {
        code: input.code ?? null,
        message: input.message,
    });
    return this.findJobById(jobId);
}
