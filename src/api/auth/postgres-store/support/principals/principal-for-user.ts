import { PostgresAuthStore,parseJson,PrincipalRecord } from "../../../postgres-store.ts";
export async function principalForUserMethod(this: PostgresAuthStore, userId: string): Promise<PrincipalRecord> {
    const user = await this.loadUser(userId);
    if (!user) {
        throw new Error(`Unknown user "${userId}".`);
    }
    const roles = await this.rolesForUser(userId);
    const permissions = await this.permissionsForUser(userId);
    const preferences = await this.first<{ color_scheme?: string; theme_mode?: string }>(
        'SELECT color_scheme, theme_mode FROM user_preferences WHERE user_id = ? LIMIT 1', [userId]);
    const metadata = parseJson(user.metadata_json, {});
    return {
        userId,
        principal: {
            id: user.id,
            displayName: user.display_name ?? undefined,
            roles,
            permissions,
            scopes: this.scopesForPrincipal(permissions),
            metadata: {
                ...metadata,
                appearance: preferences ? {
                    ...(metadata.appearance && typeof metadata.appearance === 'object' ? metadata.appearance : {}),
                    scheme: preferences.color_scheme ?? 'fern',
                    mode: preferences.theme_mode ?? 'system',
                } : metadata.appearance,
                email: user.email ?? undefined,
                username: user.username ?? undefined,
            },
        },
    };
}
