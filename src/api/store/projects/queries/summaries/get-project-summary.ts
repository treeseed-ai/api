import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function getProjectSummaryMethod(this: MarketControlPlaneStore, projectId, principal = null) {
    const details = await this.getProjectDetails(projectId);
    if (!details) {
        return null;
    }
    const [jobs, activity, products, summarySnapshot] = await Promise.all([
        this.listRecentJobsForProject(projectId, 12),
        this.listProjectActivity(projectId, 12),
        this.listCatalogArtifactVersions(projectId),
        this.getProjectSummarySnapshot(projectId),
    ]);
    const metadata = details.project.metadata ?? {};
    const failedJobs = jobs.filter((job) => job.status === 'failed');
    const activeJobs = jobs.filter((job) => ['queued', 'claimed', 'running'].includes(job.status));
    const health = {
        state: failedJobs.length > 0 ? 'attention_required' : activeJobs.length > 0 ? 'work_in_progress' : 'ready',
        summary: failedJobs.length > 0
            ? 'Recent project work requires attention.'
            : activeJobs.length > 0
                ? 'Project work is currently running.'
                : 'Project records are available.',
    };
    return {
        project: details.project,
        teamId: details.project.teamId,
        health,
        counts: {
            objectives: Number(metadata.objectiveCount ?? metadata.objectives ?? 0),
            questions: Number(metadata.questionCount ?? 0),
            notes: Number(metadata.noteCount ?? 0),
            proposals: Number(metadata.proposalCount ?? 0),
            decisions: Number(metadata.decisionCount ?? 0),
            activeWorkstreams: Number(Array.isArray(metadata.workstreams) ? metadata.workstreams.length : 0),
            agents: Number(metadata.agentCount ?? 0),
            artifacts: products.length,
        },
        repositories: details.repositories,
        contentSource: details.contentSource,
        summarySnapshot,
        docsAutomation: summarySnapshot?.summary?.docsAutomation ?? null,
        recentActivity: activity,
        nextBestAction: failedJobs.length > 0
            ? 'Inspect the latest failed project job.'
            : 'Open Direct or Workstreams to continue knowledge work.',
    };
}
