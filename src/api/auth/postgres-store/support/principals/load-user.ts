import { PostgresAuthStore,UserRow } from "../../../postgres-store.ts";
export async function loadUserMethod(this: PostgresAuthStore, userId: string) {
    return this.first<UserRow>(`SELECT * FROM users WHERE id = ?`, [userId]);
}

