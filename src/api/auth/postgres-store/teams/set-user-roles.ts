import { PostgresAuthStore } from "../../postgres-store.ts";
export async function setUserRolesMethod(this: PostgresAuthStore, userId: string, roles: string[]) {
    await this.ensureInitialized();
    const requestedRoles = [...new Set(roles.map((role) => role.trim()).filter(Boolean))];
	const currentRoles = await this.rolesForUser(userId);
	if (currentRoles.includes('platform_admin') && !requestedRoles.includes('platform_admin')) {
		const count = await this.first<{ count: number }>(`SELECT COUNT(DISTINCT bindings.user_id) AS count
			FROM user_role_bindings bindings
			INNER JOIN roles ON roles.id = bindings.role_id
			WHERE roles.key = 'platform_admin'`);
		if (Number(count?.count ?? 0) <= 1) throw new Error('The final platform administrator cannot be removed.');
	}
    await this.replaceRoles(userId, requestedRoles.length > 0 ? requestedRoles : ['member']);
    await this.writeAuditEvent({
        actorType: 'service',
        actorId: this.config.webServiceId,
        eventType: 'auth.user_roles_set',
        targetType: 'user',
        targetId: userId,
        data: { roles: requestedRoles },
    });
    return this.principalForUser(userId);
}

