import { isoNow,ControlPlaneStore } from "../../../../persistence/store.ts";
export async function pullJobsForRunnerMethod(this: ControlPlaneStore, projectId, input: any = {}) {
    await this.ensureInitialized();
    const limit = Math.max(1, Math.min(Number(input.limit ?? 1), 20));
    const rows = await this.all(`SELECT * FROM remote_jobs
			 WHERE project_id = ? AND status = 'pending'
			 ORDER BY created_at ASC
			 LIMIT ?`, [projectId, limit]);
    const claimed = [];
    for (const row of rows) {
        const timestamp = isoNow();
        await this.run(`UPDATE remote_jobs
				 SET status = 'claimed',
				     assigned_runner_id = ?,
				     started_at = COALESCE(started_at, ?),
				     updated_at = ?
				 WHERE id = ?`, [input.runnerId ?? `runner-${projectId}`, timestamp, timestamp, row.id]);
        await this.appendJobEvent(row.id, 'claimed', {
            runnerId: input.runnerId ?? `runner-${projectId}`,
        });
        claimed.push(await this.findJobById(row.id));
    }
    return claimed;
}
