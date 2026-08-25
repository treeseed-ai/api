import { PostgresAuthStore } from "../../postgres-store.ts";
export async function rolesForUserMethod(this: PostgresAuthStore, userId: string) {
    const rows = await this.all<{
        key: string;
    }>(`SELECT roles.key AS key
			 FROM user_role_bindings
			 INNER JOIN roles ON roles.id = user_role_bindings.role_id
			 WHERE user_role_bindings.user_id = ?`, [userId]);
    return rows.map((row) => row.key);
}

