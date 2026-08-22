import { PostgresAuthStore } from "../../../postgres-store.ts";
export async function permissionsForUserMethod(this: PostgresAuthStore, userId: string) {
    const rows = await this.all<{
        key: string;
    }>(`SELECT DISTINCT permissions.key AS key
			 FROM user_role_bindings
			 INNER JOIN role_permissions ON role_permissions.role_id = user_role_bindings.role_id
			 INNER JOIN permissions ON permissions.id = role_permissions.permission_id
			 WHERE user_role_bindings.user_id = ?`, [userId]);
    return rows.map((row) => row.key);
}

