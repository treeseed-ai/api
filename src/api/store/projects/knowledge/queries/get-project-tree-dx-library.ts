import { ControlPlaneStore,serializeTreeDxProjectLibrary } from "../../../../persistence/store.ts";
import type { TreeDxProjectLibraryRow } from "../../../../persistence/store.ts";
export async function getProjectTreeDxLibraryMethod(this: ControlPlaneStore, projectId: string) {
    await this.ensureInitialized();
    return serializeTreeDxProjectLibrary(await this.first<TreeDxProjectLibraryRow>(`SELECT * FROM treedx_project_libraries WHERE project_id = ? LIMIT 1`, [projectId]));
}
