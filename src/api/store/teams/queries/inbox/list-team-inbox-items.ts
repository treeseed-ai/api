import { compareDatesDesc,latestDate,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function listTeamInboxItemsMethod(this: MarketControlPlaneStore, teamId, principal = null) {
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
        const [jobs, products] = await Promise.all([
            this.listRecentJobsForProject(project.id, 10),
            this.listCatalogArtifactVersions(project.id),
        ]);
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
        if (products.length > 0) {
            items.push({
                id: `share:${project.id}`,
                teamId,
                projectId: project.id,
                kind: 'share',
                state: 'informational',
                title: `${project.name}: artifacts available`,
                summary: 'Release artifacts exist for this project and can be packaged as operational resources.',
                href: '/app/knowledge/artifacts',
                createdAt: products[0].publishedAt,
            });
        }
    }
    return items
        .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
        .filter((item) => item.createdAt)
        .sort((left, right) => compareDatesDesc(left.createdAt, right.createdAt))
        .slice(0, 20);
}
