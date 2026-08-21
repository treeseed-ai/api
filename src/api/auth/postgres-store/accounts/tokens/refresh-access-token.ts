import { randomUUID } from 'node:crypto';
import type { TokenRefreshRequest,TokenRefreshResponse } from "../../../../types.ts";
import { addSeconds,PostgresAuthStore,isoNow,now,parseJson,stableHash } from "../../../postgres-store.ts";
import { createAccessToken,nextOpaqueToken } from "../../../tokens.ts";
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
    const nextRefreshHash = stableHash(nextRefreshToken, this.config.authSecret);
    const nextRefreshExpiresAt = addSeconds(now(), this.config.refreshTokenTtlSeconds);
    await this.run(`UPDATE auth_sessions SET refresh_token_hash = ?, expires_at = ?, updated_at = ? WHERE id = ?`, [nextRefreshHash, nextRefreshExpiresAt.toISOString(), isoNow(), row.id]);
    const requestedScopes = parseJson<string[]>(row.scopes_json, principalRecord.principal.scopes);
    const expiresAt = addSeconds(now(), this.config.accessTokenTtlSeconds);
    const accessToken = createAccessToken({
        sub: principalRecord.principal.id,
        displayName: principalRecord.principal.displayName,
        scopes: requestedScopes,
        roles: principalRecord.principal.roles,
        permissions: principalRecord.principal.permissions,
        metadata: principalRecord.principal.metadata,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(expiresAt.getTime() / 1000),
        iss: this.config.issuer,
        jti: randomUUID(),
        tokenType: 'access',
    }, this.config.authSecret);
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

