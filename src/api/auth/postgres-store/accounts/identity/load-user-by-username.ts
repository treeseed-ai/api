import { PostgresAuthStore,UserRow } from "../../../postgres-store.ts";
export async function loadUserByUsernameMethod(this: PostgresAuthStore, username: string) {
    return this.first<UserRow>(`SELECT * FROM users WHERE LOWER(username) = LOWER(?) AND status = 'active' LIMIT 1`, [username]);
}

