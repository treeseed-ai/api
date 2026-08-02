import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function getProjectShareSummaryMethod(this: MarketControlPlaneStore, projectId, principal = null) {
    const [project, item, artifacts] = await Promise.all([
        this.getProject(projectId),
        this.getCatalogItem(projectId),
        this.listCatalogArtifactVersions(projectId),
    ]);
    if (!project) {
        return null;
    }
    return {
        projectId,
        project,
        listing: item,
        artifacts,
        packages: [],
        canPublish: Boolean(item && item.listingEnabled),
    };
}
