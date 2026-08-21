import { COMMONS_TEAM_SLUG,isoNow,ControlPlaneStore } from "../../../../persistence/store.ts";
export async function ensureCommonsTeamMethod(this: ControlPlaneStore) {
    await this.ensureInitialized();
    const existing = await this.getTeamBySlug(COMMONS_TEAM_SLUG);
    if (existing?.id)
        return existing;
    const timestamp = isoNow();
    await this.run(`INSERT INTO teams (id, slug, name, display_name, logo_url, profile_summary, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`, [
        COMMONS_TEAM_SLUG,
        COMMONS_TEAM_SLUG,
        COMMONS_TEAM_SLUG,
        'TreeSeed',
        'Commons team for registered participants, proposals, questions, voting, and bounded steward decisions.',
        JSON.stringify({ commons: true, cooperativeGovernance: true }),
        timestamp,
        timestamp,
    ]);
    return this.getTeam(COMMONS_TEAM_SLUG);
}
