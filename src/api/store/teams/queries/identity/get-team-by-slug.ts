import { ControlPlaneStore,normalizeTeamName,serializeTeam } from "../../../../persistence/store.ts";
import type { NativeTeamRow } from '../../../support/teams/teams.ts';
export async function getTeamBySlugMethod(this: ControlPlaneStore, slug: unknown) {
    await this.ensureInitialized();
    const value = normalizeTeamName(slug);
    return serializeTeam(await this.first<NativeTeamRow>(`SELECT * FROM teams WHERE LOWER(name) = LOWER(?) OR LOWER(slug) = LOWER(?) LIMIT 1`, [value, value]));
}
