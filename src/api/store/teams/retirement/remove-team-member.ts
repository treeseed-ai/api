import { MarketControlPlaneStore } from "../../../persistence/store.ts";
export async function removeTeamMemberMethod(this: MarketControlPlaneStore, teamId, membershipId, expectedVersion) {
    await this.ensureInitialized();
    const membership = await this.first(`SELECT * FROM team_memberships WHERE id = ? AND team_id = ? LIMIT 1`, [membershipId, teamId]);
    if (!membership?.id)
        return { ok: false, code: 'missing', message: 'Team member not found.' };
    if (expectedVersion && String(membership.updated_at) !== String(expectedVersion)) {
        return { ok: false, code: 'stale', message: 'The member changed. Reload and try again.' };
    }
    await this.batch([
        {
            query: `UPDATE teams SET updated_at = updated_at WHERE id = ?`,
            params: [teamId],
        },
        {
            query: `DELETE FROM team_memberships
                    WHERE id = ? AND team_id = ?
                      AND (
                        NOT EXISTS (
                            SELECT 1 FROM team_role_bindings binding
                            INNER JOIN roles role ON role.id = binding.role_id
                            WHERE binding.team_membership_id = ? AND role.key = 'team_owner'
                        )
                        OR EXISTS (
                            SELECT 1 FROM team_memberships owner_membership
                            INNER JOIN team_role_bindings owner_binding ON owner_binding.team_membership_id = owner_membership.id
                            INNER JOIN roles owner_role ON owner_role.id = owner_binding.role_id
                            WHERE owner_membership.team_id = ? AND owner_membership.id <> ?
                              AND owner_membership.status = 'active' AND owner_role.key = 'team_owner'
                        )
                      )`,
            params: [membershipId, teamId, membershipId, teamId, membershipId],
        },
    ]);
    if (await this.first(`SELECT id FROM team_memberships WHERE id = ? AND team_id = ?`, [membershipId, teamId])) {
        return { ok: false, code: 'last_owner', message: 'A team must keep at least one owner.' };
    }
    return { ok: true };
}
