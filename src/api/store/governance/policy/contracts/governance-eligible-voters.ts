import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function governanceEligibleVotersMethod(this: MarketControlPlaneStore, teamId, providerId = 'admin_approval_v1') {
    const members = await this.listTeamMembers(teamId);
    return members
        .filter((member) => member.status === 'active')
        .map((member) => {
        const roles = new Set(member.roles ?? []);
        const stakeWeight = roles.has('team_owner') ? 3 : roles.has('project_lead') ? 2 : roles.has('market_steward') ? 2 : 1;
        return {
            userId: member.userId,
            teamMemberId: member.id,
            activeForQuorum: true,
            chambers: [
                { chamberId: 'member_chamber', eligible: true, weight: 1, source: 'team_membership', evidence: { roles: member.roles ?? [] } },
                { chamberId: 'stake_chamber', eligible: providerId === 'treeseed_bicameral_v1', weight: stakeWeight, source: 'team_role_weight', evidence: { roles: member.roles ?? [] } },
                { chamberId: 'admin_chamber', eligible: roles.has('team_owner') || roles.has('project_lead') || roles.has('market_steward'), weight: 1, source: 'team_manager_role', evidence: { roles: member.roles ?? [] } },
            ],
        };
    });
}
