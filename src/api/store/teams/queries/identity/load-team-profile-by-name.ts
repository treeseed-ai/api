import { ControlPlaneStore,teamIsPrivate } from "../../../../persistence/store.ts";
import { publicTeamKnowledgeProfile } from '../../../public-profiles/knowledge-profile.ts';
export async function loadTeamProfileByNameMethod(this: ControlPlaneStore, name, principal = null) {
    const team = await this.getTeamByName(name);
    if (!team || team.status !== 'active')
        return null;
    const memberContext = principal ? await this.resolvePrincipalTeamContext(team.id, principal) : null;
    if (teamIsPrivate(team) && !memberContext)
        return null;
    const globallyAuthorized = !teamIsPrivate(team) && Boolean(principal
        && (principal.permissions?.includes?.('*:*:*')
            || principal.roles?.includes?.('platform_admin')
            || principal.roles?.includes?.('market_admin')));
    return {
        team: {
            ...(memberContext || globallyAuthorized ? { id: team.id } : {}),
            name: team.name,
            displayName: team.displayName,
            logoUrl: team.logoUrl,
            profileSummary: team.profileSummary,
            createdAt: team.createdAt,
        },
        knowledge: await publicTeamKnowledgeProfile(this, team.id),
    };
}
