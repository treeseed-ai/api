import { ControlPlaneStore,serializeProject, type ProjectRow } from "../../../../persistence/store.ts";
import { principalIsAdmin } from "../../../support/foundation.ts";
import type { OperationInvocationContext } from '../../../../control-plane/catalog/operation-registry.ts';
export async function listProjectsForPrincipalMethod(this: ControlPlaneStore, principal: OperationInvocationContext['principal'] | null) {
    await this.ensureInitialized();
    if (principalIsAdmin(principal)) {
        const rows = await this.all<ProjectRow>(`SELECT * FROM projects ORDER BY created_at ASC`);
        return rows.map(serializeProject).filter((project) => project?.metadata?.deletion?.status !== 'succeeded');
    }
    const teamIds = await this.teamIdsForPrincipal(principal);
    if (teamIds.length === 0) {
        return [];
    }
    const placeholders = teamIds.map(() => '?').join(', ');
    const rows = await this.all<ProjectRow>(`SELECT * FROM projects WHERE team_id IN (${placeholders}) ORDER BY created_at ASC`, teamIds);
    return rows.map(serializeProject).filter((project) => project?.metadata?.deletion?.status !== 'succeeded');
}
