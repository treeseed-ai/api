import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,normalizeTeamRoleKey } from "../../../persistence/store.ts";
export async function updateTeamMemberRoleMethod(this: MarketControlPlaneStore, teamId, membershipId, roleKey, expectedVersion) {
    await this.ensureInitialized();
    const role = normalizeTeamRoleKey(roleKey);
    const membership = await this.first(`SELECT * FROM team_memberships WHERE id = ? AND team_id = ? LIMIT 1`, [membershipId, teamId]);
    if (!membership?.id)
        return { ok: false, code: 'missing', message: 'Team member not found.' };
    if (expectedVersion && String(membership.updated_at) !== String(expectedVersion)) {
        return { ok: false, code: 'stale', message: 'The member changed. Reload and try again.' };
    }
    const roleId = await this.roleIdForKey(role);
    const timestamp = isoNow();
    await this.batch([
        { query: `UPDATE teams SET updated_at = updated_at WHERE id = ?`, params: [teamId] },
        {
            query: `DELETE FROM team_role_bindings
                    WHERE team_membership_id = ?
                      AND (
                        ? = 'team_owner'
                        OR NOT EXISTS (
                            SELECT 1 FROM team_role_bindings existing_binding
                            INNER JOIN roles existing_role ON existing_role.id = existing_binding.role_id
                            WHERE existing_binding.team_membership_id = ? AND existing_role.key = 'team_owner'
                        )
                        OR EXISTS (
                            SELECT 1 FROM team_memberships owner_membership
                            INNER JOIN team_role_bindings owner_binding ON owner_binding.team_membership_id = owner_membership.id
                            INNER JOIN roles owner_role ON owner_role.id = owner_binding.role_id
                            WHERE owner_membership.team_id = ? AND owner_membership.id <> ?
                              AND owner_membership.status = 'active' AND owner_role.key = 'team_owner'
                        )
                      )`,
            params: [membershipId, role, membershipId, teamId, membershipId],
        },
        {
            query: `INSERT INTO team_role_bindings (id, team_membership_id, role_id, created_at)
                    SELECT ?, ?, ?, ?
                    WHERE NOT EXISTS (SELECT 1 FROM team_role_bindings WHERE team_membership_id = ?)`,
            params: [randomUUID(), membershipId, roleId, timestamp, membershipId],
        },
        { query: `UPDATE team_memberships SET updated_at = ? WHERE id = ?`, params: [timestamp, membershipId] },
    ]);
    const updatedRoles = await this.listRoleKeysForMembership(membershipId);
    if (!updatedRoles.includes(role)) {
        return { ok: false, code: 'last_owner', message: 'A team must keep at least one owner.' };
    }
    return { ok: true, member: (await this.listTeamMembers(teamId)).find((member) => member.id === membershipId) ?? null };
}
