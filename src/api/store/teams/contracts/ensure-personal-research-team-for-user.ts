import { ControlPlaneStore,validateTeamName } from "../../../persistence/store.ts";
export async function ensurePersonalResearchTeamForUserMethod(this: ControlPlaneStore, userId) {
    await this.ensureInitialized();
    const user = await this.first(`SELECT id, username, display_name FROM users WHERE id = ? LIMIT 1`, [userId]);
    const validation = validateTeamName(user?.username);
    if (!user?.id || !validation.ok) {
        return { ok: false, code: 'missing_username', message: 'A valid username is required before creating a personal research team.' };
    }
    const existing = await this.getTeamBySlug(validation.name);
    if (existing) {
        const memberships = await this.all(`SELECT id FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active' LIMIT 1`, [existing.id, user.id]);
        if (memberships.length > 0 && existing.metadata?.kind === 'personal_research' && existing.metadata?.ownerUserId === user.id) {
            return { ok: true, team: existing, created: false };
        }
        return { ok: false, code: 'namespace_conflict', message: 'That username is already used by a team.' };
    }
    const team = await this.createTeam({
        name: validation.name,
        displayName: String(user.display_name ?? '').trim() || `${validation.name}'s Research`,
        metadata: {
            kind: 'personal_research',
            ownerUserId: user.id,
        },
        ownerUserId: user.id,
        allowUserNamespaceOwnerId: user.id,
    });
    return { ok: true, team, created: true };
}
