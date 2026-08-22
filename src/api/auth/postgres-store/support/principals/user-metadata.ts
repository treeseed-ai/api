import type { UserIdentityProfileInput } from "../../../../types.ts";
import { PostgresAuthStore } from "../../../postgres-store.ts";
export function userMetadataMethod(this: PostgresAuthStore, identity: UserIdentityProfileInput, existingUsername: string | null = null) {
    const profile = identity.profile ?? {};
    return {
        emailVerified: identity.emailVerified ?? false,
        authProvider: identity.provider,
        username: identity.username ?? existingUsername,
        firstName: typeof profile.firstName === 'string' ? profile.firstName : null,
        lastName: typeof profile.lastName === 'string' ? profile.lastName : null,
    };
}

