import { PostgresAuthStore } from "../../../postgres-store.ts";

export function boundScopes(requested: string[], permitted: string[]) {
    const allowed = new Set(permitted);
    return [...new Set(requested)].filter((scope) => allowed.has(scope));
}

export function scopesForPrincipalMethod(this: PostgresAuthStore, permissions: string[]) {
    const administrator = permissions.includes('*:*:*');
    const scopes = new Set<string>(['treeseed:read']);
    if (administrator || permissions.some((permission) => permission.startsWith('knowledge:') && permission !== 'knowledge:read'))
        scopes.add('treeseed:knowledge:write');
    if (administrator || permissions.includes('projects:manage:team'))
        scopes.add('treeseed:governance:write');
    // OAuth scopes limit what a delegated client may ask to do; resource RBAC still
    // decides whether the principal may mutate a particular account, team, or project.
    // A normal registered member therefore needs the shared write scope to manage
    // their own account and create their first team before a team role can exist.
    if (administrator || permissions.includes('api_tokens:create:self') || permissions.includes('projects:manage:team') || permissions.includes('services:manage:team'))
        scopes.add('treeseed:projects:write');
    if (administrator || permissions.some((permission) => ['sdk:execute:global', 'agent:execute:global', 'operations:execute:global'].includes(permission)))
        scopes.add('treeseed:execution');
    if (administrator) scopes.add('treeseed:admin');
    return [...scopes];
}
