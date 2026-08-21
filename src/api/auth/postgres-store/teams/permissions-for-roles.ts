import { PostgresAuthStore } from "../../postgres-store.ts";
export async function permissionsForRolesMethod(this: PostgresAuthStore, roleKeys: string[]) {
    if (roleKeys.length === 0) {
        return [];
    }
    const placeholders = roleKeys.map(() => '?').join(', ');
    const rows = await this.all<{
        key: string;
    }>(`SELECT DISTINCT permissions.key AS key
			 FROM roles
			 INNER JOIN role_permissions ON role_permissions.role_id = roles.id
			 INNER JOIN permissions ON permissions.id = role_permissions.permission_id
			 WHERE roles.key IN (${placeholders})`, roleKeys);
    return rows.map((row) => row.key);
}

