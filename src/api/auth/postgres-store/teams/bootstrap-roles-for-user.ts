import type { UserIdentityProfileInput } from "../../../types.ts";
import { PostgresAuthStore } from "../../postgres-store.ts";
export async function bootstrapRolesForUserMethod(this: PostgresAuthStore, userId: string, identity: UserIdentityProfileInput) {
    await this.assignRole(userId, 'member');
    if ((await this.rolesForUser(userId)).includes('platform_admin'))
        return;
    const allowlist = this.config.bootstrapAdminAllowlist;
    const email = identity.email?.trim().toLowerCase() ?? '';
    const providerSubject = `${identity.provider}:${identity.providerSubject}`;
    if (allowlist.includes(email) || allowlist.includes(providerSubject)) {
        await this.assignRole(userId, 'platform_admin');
        await this.writeAuditEvent({
            actorType: 'system',
            actorId: null,
            eventType: 'auth.bootstrap_admin',
            targetType: 'user',
            targetId: userId,
            data: { matched: allowlist.includes(providerSubject) ? providerSubject : email },
        });
    }
}

