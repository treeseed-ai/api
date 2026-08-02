import { MarketControlPlaneStore } from "../../../../../persistence/store.ts";
export async function listTeamProductsMethod(this: MarketControlPlaneStore, teamId, principal = null) {
    const items = await this.listCatalogItems(principal, { teamId });
    const latestArtifacts = new Map();
    for (const item of items) {
        const latest = (await this.listCatalogArtifactVersions(item.id))[0] ?? null;
        latestArtifacts.set(item.id, latest);
    }
    return items.map((item) => ({
        ...item,
        latestArtifact: latestArtifacts.get(item.id) ?? null,
    }));
}
