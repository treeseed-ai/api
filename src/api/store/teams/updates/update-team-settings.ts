import { isoNow,ControlPlaneStore,validateTeamName } from "../../../persistence/store.ts";
export async function updateTeamSettingsMethod(this: ControlPlaneStore, teamId, input) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const existing = await this.getTeam(teamId);
    if (!existing)
        return null;
    if (input.expectedUpdatedAt && input.expectedUpdatedAt !== existing.updatedAt) {
        return { ok: false, code: 'stale', message: 'The team settings changed. Reload and review the latest values.' };
    }
    const requestedName = input.name === undefined || input.name === null || String(input.name).trim() === ''
        ? existing.name
        : String(input.name);
    const validation = validateTeamName(requestedName);
    if (!validation.ok) {
        return { ok: false, code: validation.code, message: validation.message, fieldErrors: { name: validation.message } };
    }
    if (validation.name !== existing.name && !(await this.isTeamNameAvailable(validation.name, teamId))) {
        return { ok: false, code: 'taken', message: 'That team name is already taken.', fieldErrors: { name: 'That team name is already taken.' } };
    }
    const displayName = String(input.displayName ?? existing.displayName ?? existing.name).trim() || existing.name;
    const logoUrl = typeof input.logoUrl === 'string' && input.logoUrl.trim() ? input.logoUrl.trim() : null;
    const profileSummary = typeof input.profileSummary === 'string' && input.profileSummary.trim()
        ? input.profileSummary.trim()
        : typeof input.description === 'string' && input.description.trim()
            ? input.description.trim()
            : null;
    const metadata = {
        ...(existing.metadata ?? {}),
        ...(typeof input.metadata === 'object' && input.metadata ? input.metadata : {}),
    };
    await this.run(`UPDATE teams
			 SET slug = ?, name = ?, display_name = ?, logo_url = ?, profile_summary = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [validation.name, validation.name, displayName, logoUrl, profileSummary, JSON.stringify(metadata), timestamp, teamId]);
    return { ok: true, team: await this.getTeam(teamId) };
}
