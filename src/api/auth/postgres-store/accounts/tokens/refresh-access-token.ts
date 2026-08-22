import type { TokenRefreshRequest,TokenRefreshResponse } from "../../../../types.ts";
import { addSeconds,PostgresAuthStore,isoNow,now,parseJson,stableHash } from "../../../postgres-store.ts";
import { nextOpaqueToken } from "../../../tokens.ts";
export async function refreshAccessTokenMethod(this: PostgresAuthStore, request: TokenRefreshRequest): Promise<TokenRefreshResponse> {
    await this.ensureInitialized();
    const refreshHash = stableHash(request.refreshToken, this.config.authSecret);
    const row = await this.first<{
        id: string;
        user_id: string;
        scopes_json: string;
        expires_at: string;
    }>(`SELECT * FROM auth_sessions WHERE refresh_token_hash = ? AND revoked_at IS NULL`, [refreshHash]);
    if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
        throw new Error('Refresh token is invalid or expired.');
    }
    const principalRecord = await this.principalForUser(row.user_id);
    const nextRefreshToken = nextOpaqueToken('refresh');
    const accessToken = nextOpaqueToken('access');
    const nextRefreshHash = stableHash(nextRefreshToken, this.config.authSecret);
    const accessTokenHash = stableHash(accessToken, this.config.authSecret);
    const nextRefreshExpiresAt = addSeconds(now(), this.config.refreshTokenTtlSeconds);
    const requestedScopes = parseJson<string[]>(row.scopes_json, principalRecord.principal.scopes);
    const expiresAt = addSeconds(now(), this.config.accessTokenTtlSeconds);
    const rotated = await this.first<{ id: string }>(`UPDATE auth_sessions
        SET access_token_hash = ?, access_expires_at = ?, refresh_token_hash = ?, expires_at = ?, updated_at = ?
        WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL RETURNING id`, [
        accessTokenHash, expiresAt.toISOString(), nextRefreshHash, nextRefreshExpiresAt.toISOString(), isoNow(), row.id, refreshHash,
    ]);
    if (!rotated) throw new Error('Refresh token replay detected.');
    return {
        ok: true,
        accessToken,
        refreshToken: nextRefreshToken,
        tokenType: 'Bearer',
        expiresAt: expiresAt.toISOString(),
        expiresInSeconds: this.config.accessTokenTtlSeconds,
        principal: {
            ...principalRecord.principal,
            scopes: requestedScopes,
        },
    };
}
