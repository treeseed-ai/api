import { randomUUID } from 'node:crypto';
import type { TrustedUserAssertionClaims } from "../../../../types.ts";
import { addSeconds,PostgresAuthStore,isoNow,now,stableHash } from "../../../postgres-store.ts";
import { nextOpaqueToken } from "../../../tokens.ts";
export async function exchangeTrustedUserAssertionMethod(this: PostgresAuthStore, claims: TrustedUserAssertionClaims) {
    await this.ensureInitialized();
    const principalRecord = await this.principalForUser(claims.userId);
    const expiresAt = addSeconds(now(), this.config.webExchangeTtlSeconds);
    const accessToken = nextOpaqueToken('delegation');
    const tokenId = randomUUID();
    await this.run(`INSERT INTO api_tokens (id, user_id, kind, name, token_prefix, token_hash, scopes_json, expires_at, last_used_at, revoked_at, metadata_json, created_at, updated_at)
        VALUES (?, ?, 'delegation', 'TreeSeed site delegation', ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`, [
        tokenId, claims.userId, accessToken.slice(0, 16), stableHash(accessToken, this.config.authSecret),
        JSON.stringify(principalRecord.principal.scopes), expiresAt.toISOString(), JSON.stringify({
            ...principalRecord.principal.metadata,
            actingSessionId: claims.sessionId,
            identityId: claims.identityId,
            teamId: claims.teamId ?? null,
            projectId: claims.projectId ?? null,
            membershipId: claims.membershipId ?? null,
            teamRoles: [...new Set((claims.teamRoles ?? []).filter((entry) => typeof entry === 'string' && entry.trim()))],
            teamCapabilities: [...new Set((claims.teamCapabilities ?? []).filter((entry) => typeof entry === 'string' && entry.trim()))],
            authTime: claims.authTime,
        }), isoNow(), isoNow(),
    ]);
    await this.writeAuditEvent({
        actorType: 'service',
        actorId: this.config.webServiceId,
        eventType: 'auth.web_exchange',
        targetType: 'user',
        targetId: claims.userId,
        data: { sessionId: claims.sessionId },
    });
    return {
        ok: true as const,
        accessToken,
        tokenType: 'Bearer' as const,
        expiresAt: expiresAt.toISOString(),
        expiresInSeconds: this.config.webExchangeTtlSeconds,
        principal: principalRecord.principal,
    };
}
