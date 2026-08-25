import { ControlPlaneStore,normalizeTeamName,serializeTeam } from "../../../../persistence/store.ts";
export async function getTeamBySlugMethod(this: ControlPlaneStore, slug) {
    await this.ensureInitialized();
    const value = normalizeTeamName(slug);
    return serializeTeam(await this.first(`SELECT * FROM teams WHERE LOWER(name) = LOWER(?) OR LOWER(slug) = LOWER(?) LIMIT 1`, [value, value]));
}
