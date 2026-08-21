import { ControlPlaneStore } from "../../../../persistence/store.ts";
export async function getProjectDirectSummaryMethod(this: ControlPlaneStore, projectId, principal = null) {
    const project = await this.getProject(projectId);
    if (!project) {
        return null;
    }
    const metadata = project.metadata ?? {};
    return {
        projectId,
        objectiveCount: Number(metadata.objectiveCount ?? 0),
        questionCount: Number(metadata.questionCount ?? 0),
        noteCount: Number(metadata.noteCount ?? 0),
        proposalCount: Number(metadata.proposalCount ?? 0),
        decisionCount: Number(metadata.decisionCount ?? 0),
        savedViews: Array.isArray(metadata.directViews) && metadata.directViews.length > 0
            ? metadata.directViews
            : ['Now', 'Blocked', 'Ready for research', 'Ready for build', 'Release-linked'],
        items: Array.isArray(metadata.directItems) ? metadata.directItems : [],
    };
}
