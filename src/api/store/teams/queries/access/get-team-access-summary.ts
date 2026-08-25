import { CAPABILITY_PERMISSIONS,ControlPlaneStore,principalIsAdmin,TEAM_ROLE_DESCRIPTIONS,uniqueStrings } from "../../../../persistence/store.ts";
export async function getTeamAccessSummaryMethod(this: ControlPlaneStore, teamId, principal) {
    await this.ensureInitialized();
    const context = await this.resolvePrincipalTeamContext(teamId, principal);
    const roles = context?.roles ?? [];
    const capabilities = context?.capabilities ?? [];
    const permissions = uniqueStrings([
        ...capabilities.map((capability) => CAPABILITY_PERMISSIONS[capability]).filter(Boolean),
        ...(principal?.permissions ?? []),
    ]);
    return {
        teamId,
        roles,
        capabilities,
        permissions,
        teamPermissions: uniqueStrings(capabilities.map((capability) => CAPABILITY_PERMISSIONS[capability]).filter(Boolean)),
        accountPermissions: uniqueStrings(principal?.permissions ?? []),
        roleDescriptions: Object.fromEntries(roles.map((role) => {
            const roleKey = String(role);
            return [roleKey, TEAM_ROLE_DESCRIPTIONS[roleKey] ?? roleKey];
        })),
        summary: {
            canAdminStaging: capabilities.includes('stage_releases') || capabilities.includes('publish_releases'),
            canAdminProduction: capabilities.includes('publish_releases'),
            canDownloadTemplates: Boolean(context) || principalIsAdmin(principal),
            canDownloadKnowledgePacks: Boolean(context) || principalIsAdmin(principal),
        },
    };
}
