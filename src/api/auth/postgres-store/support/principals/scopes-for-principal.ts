import { PostgresAuthStore } from "../../../postgres-store.ts";
import { authorizedIdentityScopes } from '../../../identity/authorized-scopes.ts';

export function boundScopes(requested: string[], permitted: string[]) {
    const allowed = new Set(permitted);
    return [...new Set(requested)].filter((scope) => allowed.has(scope));
}

export function scopesForPrincipalMethod(this: PostgresAuthStore, permissions: string[]) {
    return authorizedIdentityScopes(permissions);
}
