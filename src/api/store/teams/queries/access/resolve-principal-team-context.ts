import { ALL_TEAM_CAPABILITIES,ControlPlaneStore,uniqueCapabilities } from "../../../../persistence/store.ts";
export async function resolvePrincipalTeamContextMethod(this: ControlPlaneStore, teamId, principal) {
    await this.ensureInitialized();
    if (!principal)
        return null;
    if (principal.roles?.includes?.('team_api_key') && principal.metadata?.teamId === teamId) {
        return {
            membershipId: null,
            roles: ['team_owner'],
            capabilities: [...ALL_TEAM_CAPABILITIES],
        };
    }
    const userId = typeof principal.id === 'string' ? principal.id : '';
    if (!userId)
        return null;
    const membership = await this.first(`SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active' LIMIT 1`, [teamId, userId]);
    if (!membership?.id) {
        return null;
    }
    const roles = await this.listRoleKeysForMembership(membership.id);
    const effectiveRoles = roles.length > 0 ? roles : ['team_owner'];
    return {
        membershipId: membership.id,
        roles: effectiveRoles,
        capabilities: uniqueCapabilities(effectiveRoles),
    };
}
