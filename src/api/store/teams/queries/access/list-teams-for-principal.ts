import { ControlPlaneStore,primaryTeamRole,serializeTeam } from "../../../../persistence/store.ts";
export async function listTeamsForPrincipalMethod(this: ControlPlaneStore, principal) {
    await this.ensureInitialized();
    const teamIds = await this.teamIdsForPrincipal(principal);
    if (teamIds.length === 0) {
        return [];
    }
    const placeholders = teamIds.map(() => '?').join(', ');
    const rows = await this.all(`SELECT * FROM teams WHERE id IN (${placeholders})
        ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at ASC`, teamIds);
    return Promise.all(rows.map(async (row) => {
        const team = serializeTeam(row);
        const [context, memberCount, ownerCount, pendingInviteCount, projectCount, capacityProviderCount] = await Promise.all([
            this.resolvePrincipalTeamContext(team.id, principal),
            this.first(`SELECT COUNT(*) AS count FROM team_memberships WHERE team_id = ? AND status = 'active'`, [team.id]),
            this.first(`SELECT COUNT(*) AS count
                FROM team_memberships membership
                INNER JOIN team_role_bindings binding ON binding.team_membership_id = membership.id
                INNER JOIN roles role ON role.id = binding.role_id
                WHERE membership.team_id = ? AND membership.status = 'active' AND role.key = 'team_owner'`, [team.id]),
            this.first(`SELECT COUNT(*) AS count FROM team_invites WHERE team_id = ? AND status = 'pending'`, [team.id]),
            this.first(`SELECT COUNT(*) AS count FROM projects WHERE team_id = ?`, [team.id]),
            this.first(`SELECT COUNT(*) AS count
                FROM capacity_provider_team_memberships
                WHERE team_id = ? AND status = 'approved'`, [team.id]),
        ]);
        const roles = context?.roles ?? [];
        const capabilities = context?.capabilities ?? [];
        const owner = roles.includes('team_owner');
        const manager = owner || roles.includes('project_lead');
        return {
            ...team,
            currentUserRole: primaryTeamRole(roles),
            roles,
            capabilities,
            counts: {
                members: Number(memberCount?.count ?? 0),
                pendingInvitations: Number(pendingInviteCount?.count ?? 0),
                projects: Number(projectCount?.count ?? 0),
                capacityProviders: Number(capacityProviderCount?.count ?? 0),
            },
            allowedActions: {
                setActive: team.status === 'active',
                viewOverview: true,
                edit: team.status === 'active' && manager,
                manageMembers: team.status === 'active' && manager,
                archive: team.status === 'active' && owner,
                restore: team.status === 'archived' && owner,
                delete: owner,
                leave: !owner || Number(ownerCount?.count ?? 0) > 1,
            },
        };
    }));
}
