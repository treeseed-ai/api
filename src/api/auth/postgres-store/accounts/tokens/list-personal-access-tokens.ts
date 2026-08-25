import { PostgresAuthStore } from "../../../postgres-store.ts";
export async function listPersonalAccessTokensMethod(this: PostgresAuthStore, userId: string) {
    await this.ensureInitialized();
    return this.all<{
        id: string;
        name: string;
        token_prefix: string;
        expires_at: string | null;
        last_used_at: string | null;
        revoked_at: string | null;
        created_at: string;
    }>(`SELECT id, name, token_prefix, expires_at, last_used_at, revoked_at, created_at
			 FROM api_tokens
			 WHERE user_id = ?
			 ORDER BY created_at DESC`, [userId]);
}

