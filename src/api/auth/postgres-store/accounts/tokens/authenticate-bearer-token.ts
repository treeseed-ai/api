import type { ApiCredential,ApiPrincipal } from "../../../../types.ts";
import { PostgresAuthStore,isoNow,parseJson,stableHash } from "../../../postgres-store.ts";
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
        kind: string;
    }>(`SELECT id, user_id, kind, name, scopes_json, expires_at, revoked_at
			 FROM api_tokens
			 WHERE token_hash = ?`, [patHash]);
    if (pat && !pat.revoked_at && (!pat.expires_at || new Date(pat.expires_at).getTime() > Date.now())) {
        await this.run(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, [isoNow(), pat.id]);
        const principal = (await this.principalForUser(pat.user_id)).principal;
        return {
            principal: { ...principal, scopes: parseJson<string[]>(pat.scopes_json, principal.scopes) },
            credential: { type: pat.kind === 'personal_access_token' ? 'personal_access_token' : 'access_token', id: pat.id, label: pat.name },
        };
    }
    const session = await this.first<{
        id: string; user_id: string; scopes_json: string; access_expires_at: string; revoked_at: string | null; data_json: string | null;
    }>(`SELECT id, user_id, scopes_json, access_expires_at, revoked_at, data_json
        FROM auth_sessions WHERE access_token_hash = ?`, [patHash]);
    if (!session || session.revoked_at || new Date(session.access_expires_at).getTime() <= Date.now()) return null;
    await this.run(`UPDATE auth_sessions SET updated_at = ? WHERE id = ?`, [isoNow(), session.id]);
    const principal = (await this.principalForUser(session.user_id)).principal;
    return {
        principal: { ...principal, scopes: parseJson<string[]>(session.scopes_json, principal.scopes), metadata: {
            ...(principal.metadata ?? {}), ...parseJson<Record<string, unknown>>(session.data_json, {}), sessionId: session.id,
        } },
        credential: { type: 'access_token', id: session.id, label: 'oauth-session' },
    };
}
