import { PostgresAuthStore,UserRow } from "../../../postgres-store.ts";
export async function loadUserByVerifiedEmailMethod(this: PostgresAuthStore, email: string) {
    return this.first<UserRow>(`SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND status = 'active' LIMIT 1`, [email]);
}

