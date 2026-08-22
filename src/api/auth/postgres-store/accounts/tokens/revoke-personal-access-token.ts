import { PostgresAuthStore,isoNow } from "../../../postgres-store.ts";
export async function revokePersonalAccessTokenMethod(this: PostgresAuthStore, userId: string, tokenId: string) {
    await this.ensureInitialized();
    await this.run(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?`, [isoNow(), tokenId, userId]);
    await this.writeAuditEvent({
        actorType: 'user',
        actorId: userId,
        eventType: 'auth.pat_revoked',
        targetType: 'api_token',
        targetId: tokenId,
    });
}

