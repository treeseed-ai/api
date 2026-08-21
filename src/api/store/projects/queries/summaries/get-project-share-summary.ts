import { ControlPlaneStore } from "../../../../persistence/store.ts";
export async function getProjectShareSummaryMethod(this: ControlPlaneStore, projectId, principal = null) {
    const project = await this.getProject(projectId);
    if (!project) {
        return null;
    }
    return {
        projectId,
        project,
        listing: null,
        artifacts: [],
        packages: [],
        canPublish: false,
    };
}
