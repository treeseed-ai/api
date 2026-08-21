import { PostgresAuthStore } from "../../postgres-store.ts";
export async function replaceRolesMethod(this: PostgresAuthStore, userId: string, roleKeys: string[]) {
    await this.run(`DELETE FROM user_role_bindings WHERE user_id = ?`, [userId]);
    for (const roleKey of roleKeys) {
        await this.assignRole(userId, roleKey);
    }
}

