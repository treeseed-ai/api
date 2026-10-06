import { selectedActions } from '../index.js';
import type { ControlPlaneStore } from '../../../../api/persistence/store.ts';
import type { OperationInvocationContext } from '../../../../api/control-plane/catalog/operation-registry.ts';

export function localBootstrapEmails(env = process.env) {
    return String(env.TREESEED_API_BOOTSTRAP_ADMIN_ALLOWLIST ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}

export async function findLocalSeedOwnerUser(store: Partial<Pick<ControlPlaneStore, 'findUserByEmail' | 'listActiveUsers'>>, env = process.env) {
    const allowlist = localBootstrapEmails(env);
    for (const email of allowlist) {
        const user = typeof store.findUserByEmail === 'function' ? await store.findUserByEmail(email) : null;
        if (user?.id)
            return user;
    }
    const users = typeof store.listActiveUsers === 'function' ? await store.listActiveUsers(2) : [];
    return users.length === 1 ? users[0] : null;
}

export function seedActorUser(actor?: { principal?: OperationInvocationContext['principal'] } | null) {
    const principal = actor?.principal;
    if (!principal?.id || principal.roles?.includes?.('team_api_key') || principal.roles?.includes?.('project_api')) {
        return null;
    }
    return {
        id: principal.id,
        email: principal.metadata?.email ?? null,
    };
}

export async function ensureLocalSeedTeamMemberships({ store, plan, ids, env, actor }: {
    store: Pick<ControlPlaneStore, 'resolvePrincipalTeamContext' | 'upsertTeamMember'> & Parameters<typeof findLocalSeedOwnerUser>[0];
    plan: Parameters<typeof selectedActions>[0];
    ids: { teams: Map<string, string> }; env?: NodeJS.ProcessEnv; actor?: Parameters<typeof seedActorUser>[0];
}) {
    if (!plan.environments.includes('local'))
        return [];
    const user = seedActorUser(actor) ?? await findLocalSeedOwnerUser(store, env);
    if (!user?.id)
        return [];
    const memberships = [];
    for (const action of selectedActions(plan).filter((entry) => entry.kind === 'team')) {
        const teamId = ids.teams.get(action.key) ?? action.existing?.id;
        if (!teamId)
            continue;
        const existing = await store.resolvePrincipalTeamContext(teamId, { id: user.id, roles: [] });
        if (existing?.membershipId)
            continue;
        const member = await store.upsertTeamMember(teamId, user.id, 'team_owner');
        if (member) {
            memberships.push({
                teamId,
                teamKey: action.key,
                userId: user.id,
                email: user.email ?? null,
                role: 'team_owner',
            });
        }
    }
    return memberships;
}
