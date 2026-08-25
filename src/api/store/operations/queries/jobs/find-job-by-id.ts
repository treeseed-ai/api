import { ControlPlaneStore,serializeJob } from "../../../../persistence/store.ts";
export async function findJobByIdMethod(this: ControlPlaneStore, jobId) {
    await this.ensureInitialized();
    return serializeJob(await this.first(`SELECT * FROM remote_jobs WHERE id = ?`, [jobId]));
}
