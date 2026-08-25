import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,validateTeamName } from "../../../persistence/store.ts";
export async function createTeamMethod(this: ControlPlaneStore, input) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const validation = validateTeamName(input.name ?? input.slug);
    if (!validation.ok) {
        throw new Error(validation.message);
    }
    if (await this.publicUsernameExists(validation.name, input.allowUserNamespaceOwnerId ?? null)) {
        throw new Error('That team name is already taken by a user.');
    }
    const displayName = String(input.displayName ?? input.display_name ?? input.label ?? input.name ?? validation.name).trim() || validation.name;
    const metadata = {
        visibility: 'private',
        privateTreeDx: true,
        ...(typeof input.metadata === 'object' && input.metadata ? input.metadata : {}),
    };
    await this.run(`INSERT INTO teams (id, slug, name, display_name, logo_url, profile_summary, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        validation.name,
        validation.name,
        displayName,
        typeof input.logoUrl === 'string' && input.logoUrl.trim() ? input.logoUrl.trim() : null,
        typeof input.profileSummary === 'string' && input.profileSummary.trim()
            ? input.profileSummary.trim()
            : typeof input.description === 'string' && input.description.trim()
                ? input.description.trim()
                : null,
        JSON.stringify(metadata),
        timestamp,
        timestamp,
    ]);
    if (input.ownerUserId) {
        await this.upsertTeamMember(id, input.ownerUserId, 'team_owner');
    }
    return this.getTeam(id);
}
