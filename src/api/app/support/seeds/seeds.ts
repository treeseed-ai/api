import { ensurePrincipal,isTeamApiPrincipal,jsonError,principalHasPermission,principalIsSeedAdmin } from '../index.ts';
import type { ControlPlaneStore } from '../../../persistence/store.ts';
export function normalizeSeedEnvironments(value: unknown) {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry ?? '').trim()).filter(Boolean).join(',');
    }
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
export function seedActor(c: Parameters<typeof ensurePrincipal>[0]) {
    const principal = c.get('principal');
    return {
        actorType: c.get('actorType') === 'service' ? 'service' : c.get('actorType') === 'project' ? 'project' : 'user',
        principal,
    };
}
export function seedExistingTeamIds(plan: { actions: readonly { kind: string; action: string; existing?: { id?: string } | null }[] }) {
    return [...new Set(plan.actions
            .filter((action): action is typeof action & { existing: { id: string } } => Boolean(action.kind === 'team' && action.existing?.id))
            .map((action) => action.existing.id))];
}
export function seedCreatesMissingTeams(plan: Parameters<typeof seedExistingTeamIds>[0]) {
    return plan.actions.some((action) => action.kind === 'team' && action.action === 'create');
}
export async function requireSeedPlanAccess(c: Parameters<typeof ensurePrincipal>[0], store: Pick<ControlPlaneStore, 'principalCanAccessTeam'>, plan: Parameters<typeof seedExistingTeamIds>[0]): ReturnType<typeof ensurePrincipal> {
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
export async function requireSeedApplyAccess(c: Parameters<typeof ensurePrincipal>[0], store: Pick<ControlPlaneStore, 'principalCanAccessTeam' | 'principalCanManageTeam'>, plan: Parameters<typeof seedExistingTeamIds>[0]): ReturnType<typeof ensurePrincipal> {
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
