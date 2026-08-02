import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function getProjectAccessSummaryMethod(this: MarketControlPlaneStore, projectId, principal) {
    await this.ensureInitialized();
    const details = await this.getProjectDetails(projectId);
    if (!details)
        return null;
    const team = await this.getTeamAccessSummary(details.project.teamId, principal);
    const context = await this.resolvePrincipalTeamContext(details.project.teamId, principal);
    const roles = context?.roles ?? [];
    const subjectId = typeof principal?.id === 'string' && principal.id ? principal.id : details.project.teamId;
    const subjectType = principal?.roles?.includes?.('team_api_key') ? 'api_key' : 'user';
    const environmentRole = (environment) => {
        if (team.summary.canAdminProduction || (environment === 'staging' && team.summary.canAdminStaging))
            return 'admin';
        if (roles.includes('contributor') || roles.includes('reviewer'))
            return 'operator';
        return 'viewer';
    };
    return {
        projectId,
        team,
        roles,
        environments: ['staging', 'prod'].map((environment) => ({
            projectId,
            environment,
            subjectType,
            subjectId,
            role: environmentRole(environment),
        })),
    };
}
