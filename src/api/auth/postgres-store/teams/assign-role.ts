import { randomUUID } from 'node:crypto';
import { PostgresAuthStore,isoNow } from "../../postgres-store.ts";
export async function assignRoleMethod(this: PostgresAuthStore, userId: string, roleKey: string) {
    const role = await this.first<{
        id: string;
    }>(`SELECT id FROM roles WHERE key = ?`, [roleKey]);
    if (!role)
        return;
    await this.run(`INSERT OR IGNORE INTO user_role_bindings (id, user_id, role_id, created_at)
			 VALUES (?, ?, ?, ?)`, [randomUUID(), userId, role.id, isoNow()]);
}

