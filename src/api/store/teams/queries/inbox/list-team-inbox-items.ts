import { compareDatesDesc,latestDate,ControlPlaneStore } from "../../../../persistence/store.ts";
export async function listTeamInboxItemsMethod(this: ControlPlaneStore, teamId, principal = null) {
    const team = await this.getTeam(teamId);
    if (!team) {
        return [];
    }
    const projects = await this.listTeamProjects(teamId);
    const [persistedItems] = await Promise.all([
        this.listPersistedTeamInboxItems(teamId),
    ]);
    const items: Array<{
        id: string;
        teamId: string;
        projectId: string | null;
        kind: string;
        state: string;
        title: string;
        summary: string;
        href: string;
        itemKey?: string | null;
        metadata?: Record<string, unknown>;
        createdAt: string;
        updatedAt?: string | null;
    }> = [...persistedItems];
    for (const project of projects) {
        const jobs = await this.listRecentJobsForProject(project.id, 10);
        const failedJob = jobs.find((job) => job.status === 'failed');
        if (failedJob) {
            items.push({
                id: `job:${failedJob.id}`,
                teamId,
                projectId: project.id,
                kind: 'failure',
                state: 'action_required',
                title: `${project.name}: ${failedJob.operation} failed`,
                summary: `The latest ${failedJob.namespace}:${failedJob.operation} run failed and needs review.`,
                href: `/app/projects/${project.id}/settings`,
                createdAt: latestDate(failedJob.finishedAt, failedJob.updatedAt, failedJob.createdAt),
            });
        }
    }
    return items
        .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
        .filter((item) => item.createdAt)
        .sort((left, right) => compareDatesDesc(left.createdAt, right.createdAt))
        .slice(0, 20);
}
