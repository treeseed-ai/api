import type { ApiCredential,ApiPrincipal } from "../../../../types.ts";
import { PostgresAuthStore,isoNow,parseJson,stableHash } from "../../../postgres-store.ts";
import { principalFromAccessTokenPayload,verifyAccessToken } from "../../../tokens.ts";
export async function authenticateBearerTokenMethod(this: PostgresAuthStore, token: string): Promise<{
    principal: ApiPrincipal;
    credential: ApiCredential;
} | null> {
    await this.ensureInitialized();
    const patHash = stableHash(token, this.config.authSecret);
    const pat = await this.first<{
        id: string;
        user_id: string;
        name: string;
        scopes_json: string;
        expires_at: string | null;
        revoked_at: string | null;
    }>(`SELECT id, user_id, name, scopes_json, expires_at, revoked_at
			 FROM api_tokens
			 WHERE token_hash = ?`, [patHash]);
    if (pat && !pat.revoked_at && (!pat.expires_at || new Date(pat.expires_at).getTime() > Date.now())) {
        await this.run(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, [isoNow(), pat.id]);
        const principal = (await this.principalForUser(pat.user_id)).principal;
        return {
            principal: { ...principal, scopes: parseJson<string[]>(pat.scopes_json, principal.scopes) },
            credential: { type: 'personal_access_token', id: pat.id, label: pat.name },
        };
    }
    const payload = verifyAccessToken(token, this.config.authSecret);
    if (!payload)
        return null;
    const sessionId = typeof payload.metadata?.sessionId === 'string' ? payload.metadata.sessionId.trim() : '';
    if (sessionId) {
        const session = await this.first<{
            id: string;
            user_id: string;
            expires_at: string;
            revoked_at: string | null;
        }>(`SELECT id, user_id, expires_at, revoked_at
				 FROM auth_sessions
				 WHERE id = ?`, [sessionId]);
        const sessionExpiresAt = session ? new Date(session.expires_at).getTime() : 0;
        if (!session
            || session.user_id !== payload.sub
            || session.revoked_at
            || !Number.isFinite(sessionExpiresAt)
            || sessionExpiresAt <= Date.now()) {
            return null;
        }
        await this.run(`UPDATE auth_sessions SET updated_at = ? WHERE id = ?`, [isoNow(), session.id]);
    }
    return {
        principal: principalFromAccessTokenPayload(payload),
        credential: {
            type: payload.tokenType === 'service' ? 'service_token' : 'access_token',
            id: payload.jti,
            label: payload.tokenType,
        },
    };
}

