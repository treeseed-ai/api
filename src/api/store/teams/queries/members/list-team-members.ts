import { ControlPlaneStore,serializeTeamMember,TEAM_ROLE_CAPABILITIES,TEAM_ROLE_DESCRIPTIONS,uniqueStrings } from "../../../../persistence/store.ts";
export async function listTeamMembersMethod(this: ControlPlaneStore, teamId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT team_memberships.*, users.display_name, users.email
			 FROM team_memberships
			 INNER JOIN users ON users.id = team_memberships.user_id
			 WHERE team_memberships.team_id = ?
			 ORDER BY team_memberships.created_at ASC`, [teamId]);
    if (rows.length === 0) {
        return [];
    }
    const membershipIds = rows.map((row) => row.id);
    const placeholders = membershipIds.map(() => '?').join(', ');
    const roleRows = await this.all(`SELECT team_role_bindings.team_membership_id, roles.key
			 FROM team_role_bindings
			 INNER JOIN roles ON roles.id = team_role_bindings.role_id
			 WHERE team_role_bindings.team_membership_id IN (${placeholders})`, membershipIds);
    const rolesByMembership = new Map();
    for (const row of roleRows) {
        const existing = rolesByMembership.get(row.team_membership_id) ?? [];
        existing.push(row.key);
        rolesByMembership.set(row.team_membership_id, uniqueStrings(existing));
    }
    return rows.map((row) => {
        const roles = rolesByMembership.get(row.id) ?? [];
        const member = serializeTeamMember(row, roles);
        return {
            ...member,
            joinedAt: member.createdAt,
            roleDescriptions: Object.fromEntries(roles.map((role) => [role, TEAM_ROLE_DESCRIPTIONS[role] ?? role])),
            effectiveCapabilities: uniqueStrings(roles.flatMap((role) => TEAM_ROLE_CAPABILITIES[role] ?? [])),
        };
    });
}
