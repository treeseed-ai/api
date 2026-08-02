import { MarketControlPlaneStore,teamIsPrivate } from "../../../../persistence/store.ts";
import { publicTeamKnowledgeProfile } from '../../../public-profiles/knowledge-profile.ts';
export async function loadTeamProfileByNameMethod(this: MarketControlPlaneStore, name, principal = null) {
    const team = await this.getTeamByName(name);
    if (!team || team.status !== 'active')
        return null;
    const memberContext = principal ? await this.resolvePrincipalTeamContext(team.id, principal) : null;
    if (teamIsPrivate(team) && !memberContext)
        return null;
    return {
        team: {
            name: team.name,
            displayName: team.displayName,
            logoUrl: team.logoUrl,
            profileSummary: team.profileSummary,
            createdAt: team.createdAt,
        },
        knowledge: await publicTeamKnowledgeProfile(this, team.id),
    };
}
