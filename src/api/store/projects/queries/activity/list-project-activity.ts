import { compareDatesDesc,latestDate,ControlPlaneStore,toActivityItem } from "../../../../persistence/store.ts";
export async function listProjectActivityMethod(this: ControlPlaneStore, projectId, limit = 12) {
    const jobs = await this.listRecentJobsForProject(projectId, limit);
    return [
        ...jobs.map((job) => toActivityItem('job', {
            id: job.id,
            title: `${job.namespace}:${job.operation}`,
            status: job.status,
            timestamp: latestDate(job.finishedAt, job.updatedAt, job.createdAt),
            summary: typeof job.output?.summary === 'string' ? job.output.summary : null,
            metadata: {
                selectedTarget: job.selectedTarget,
            },
        })),
    ]
        .filter((item) => item.timestamp)
        .sort((left, right) => compareDatesDesc(left.timestamp, right.timestamp))
        .slice(0, limit);
}
