import { MarketControlPlaneStore,serializeJob } from "../../../../persistence/store.ts";
export async function findJobByIdMethod(this: MarketControlPlaneStore, jobId) {
    await this.ensureInitialized();
    return serializeJob(await this.first(`SELECT * FROM remote_jobs WHERE id = ?`, [jobId]));
}
