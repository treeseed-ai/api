import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function getProjectWorkstreamsSummaryMethod(this: MarketControlPlaneStore, projectId, principal = null) {
    const project = await this.getProject(projectId);
    if (!project) {
        return null;
    }
    const jobs = await this.listRecentJobsForProject(projectId, 12);
    const metadata = project.metadata ?? {};
    return {
        projectId,
        items: Array.isArray(metadata.workstreams) ? metadata.workstreams : [],
        recentJobs: jobs,
        columns: ['Drafting', 'Active', 'Verifying', 'Saved', 'Archived'],
    };
}
