import { isoNow,MarketControlPlaneStore,normalizeProjectArchitecture,parseJson } from "../../../../persistence/store.ts";
export async function updateProjectMethod(this: MarketControlPlaneStore, projectId, input) {
    await this.ensureInitialized();
    const existing = await this.first(`SELECT * FROM projects WHERE id = ? LIMIT 1`, [projectId]);
    if (!existing) {
        return null;
    }
    const timestamp = isoNow();
    const metadata = input.metadata ?? parseJson(existing.metadata_json, {});
    const nextSlug = input.slug ?? existing.slug;
    const nextName = input.name ?? existing.name;
    const nextDescription = input.description ?? existing.description ?? null;
    await this.run(`UPDATE projects
			 SET slug = ?, name = ?, description = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        nextSlug,
        nextName,
        nextDescription,
        JSON.stringify(metadata),
        timestamp,
        projectId,
    ]);
    const existingCatalogItem = await this.getCatalogItem(projectId);
    if (existingCatalogItem) {
        await this.upsertCatalogItem(existing.team_id, {
            id: projectId,
            kind: 'project',
            slug: nextSlug,
            title: nextName,
            summary: nextDescription,
            visibility: existingCatalogItem.visibility,
            listingEnabled: existingCatalogItem.listingEnabled,
            offerMode: existingCatalogItem.offerMode,
            manifestKey: existingCatalogItem.manifestKey,
            artifactKey: existingCatalogItem.artifactKey,
            searchText: [nextName, nextDescription].filter(Boolean).join(' ').trim() || null,
            metadata: {
                ...(existingCatalogItem.metadata ?? {}),
                ...metadata,
            },
        });
    }
    if (metadata?.architecture) {
        await this.projectArchitectureContentBindings(projectId, normalizeProjectArchitecture(metadata.architecture)).catch(() => null);
    }
    return this.getProject(projectId);
}
