import { isoNow,ControlPlaneStore,normalizeProjectArchitecture,parseJson } from "../../../../persistence/store.ts";
export async function updateProjectMethod(this: ControlPlaneStore, projectId, input) {
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
    if (metadata?.architecture) {
        await this.projectArchitectureContentBindings(projectId, normalizeProjectArchitecture(metadata.architecture)).catch(() => null);
    }
    return this.getProject(projectId);
}
