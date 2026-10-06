import { ControlPlaneStore,serializeJob } from "../../../../persistence/store.ts";
import type { JobRow } from "../../../support/operations/operations.ts";
export async function findJobByIdMethod(this: ControlPlaneStore, jobId: string) {
    await this.ensureInitialized();
    return serializeJob(await this.first<JobRow>(`SELECT * FROM remote_jobs WHERE id = ?`, [jobId]));
}
