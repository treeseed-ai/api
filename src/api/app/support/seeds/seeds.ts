import { ensurePrincipal,isTeamApiPrincipal,jsonError,principalHasPermission,principalIsSeedAdmin } from '../index.ts';
export function normalizeSeedEnvironments(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry ?? '').trim()).filter(Boolean).join(',');
    }
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
export function seedActor(c) {
    const principal = c.get('principal');
    return {
        actorType: c.get('actorType') === 'service' ? 'service' : c.get('actorType') === 'project' ? 'project' : 'user',
        principal,
    };
}
export function seedExistingTeamIds(plan) {
    return [...new Set(plan.actions
            .filter((action) => action.kind === 'team' && action.existing?.id)
            .map((action) => action.existing.id))];
}
export function seedCreatesMissingTeams(plan) {
    return plan.actions.some((action) => action.kind === 'team' && action.action === 'create');
}
export async function requireSeedPlanAccess(c, store, plan) {
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    for (const teamId of seedExistingTeamIds(plan)) {
        if (!(await store.principalCanAccessTeam(auth.principal, teamId))) {
            return { response: jsonError(c, 403, 'Permission denied.', { teamId }) };
        }
    }
    return auth;
}
export async function requireSeedApplyAccess(c, store, plan) {
    const auth = await requireSeedPlanAccess(c, store, plan);
    if (auth.response)
        return auth;
    for (const teamId of seedExistingTeamIds(plan)) {
        const canManage = isTeamApiPrincipal(auth.principal)
            ? principalHasPermission(auth.principal, 'teams:manage:team')
            : await store.principalCanManageTeam(auth.principal, teamId);
        if (!canManage) {
            return { response: jsonError(c, 403, 'Permission denied.', { permission: 'teams:manage:team', teamId }) };
        }
    }
    if (seedCreatesMissingTeams(plan) && !principalIsSeedAdmin(auth.principal)) {
        return { response: jsonError(c, 403, 'Permission denied.', { permission: 'seeds:apply:global' }) };
    }
    return auth;
}
