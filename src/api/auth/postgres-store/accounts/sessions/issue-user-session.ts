import { randomUUID } from 'node:crypto';
import type { TokenRefreshResponse } from "../../../../types.ts";
import { addSeconds,PostgresAuthStore,isoNow,now,stableHash } from "../../../postgres-store.ts";
import { createAccessToken,nextOpaqueToken } from "../../../tokens.ts";
export async function issueUserSessionMethod(this: PostgresAuthStore, userId: string, options: {
    sessionType?: string;
    scopes?: string[];
    data?: Record<string, unknown>;
} = {}): Promise<TokenRefreshResponse> {
    await this.ensureInitialized();
    const principalRecord = await this.principalForUser(userId);
    const refreshToken = nextOpaqueToken('refresh');
    const sessionId = randomUUID();
    const refreshTokenHash = stableHash(refreshToken, this.config.authSecret);
    const expiresAt = addSeconds(now(), this.config.accessTokenTtlSeconds);
    const refreshExpiresAt = addSeconds(now(), this.config.refreshTokenTtlSeconds);
    const requestedScopes = options.scopes && options.scopes.length > 0 ? [...new Set(options.scopes)] : principalRecord.principal.scopes;
    await this.run(`INSERT INTO auth_sessions (id, user_id, session_type, refresh_token_hash, scopes_json, expires_at, revoked_at, data_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`, [
        sessionId,
        userId,
        options.sessionType?.trim() || 'web',
        refreshTokenHash,
        JSON.stringify(requestedScopes),
        refreshExpiresAt.toISOString(),
        JSON.stringify(options.data ?? {}),
        isoNow(),
        isoNow(),
    ]);
    const accessToken = createAccessToken({
        sub: principalRecord.principal.id,
        displayName: principalRecord.principal.displayName,
        scopes: requestedScopes,
        roles: principalRecord.principal.roles,
        permissions: principalRecord.principal.permissions,
        metadata: {
            ...principalRecord.principal.metadata,
            sessionId,
        },
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(expiresAt.getTime() / 1000),
        iss: this.config.issuer,
        jti: randomUUID(),
        tokenType: 'access',
    }, this.config.authSecret);
    await this.writeAuditEvent({
        actorType: 'user',
        actorId: userId,
        eventType: 'auth.session_issued',
        targetType: 'auth_session',
        targetId: sessionId,
        data: { sessionType: options.sessionType ?? 'web' },
    });
    return {
        ok: true,
        status: 'approved',
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresAt: expiresAt.toISOString(),
        expiresInSeconds: this.config.accessTokenTtlSeconds,
        principal: {
            ...principalRecord.principal,
            scopes: requestedScopes,
            metadata: {
                ...(principalRecord.principal.metadata ?? {}),
                sessionId,
            },
        },
    };
}

