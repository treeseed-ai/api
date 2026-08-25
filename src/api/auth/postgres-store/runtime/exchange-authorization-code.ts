import { createHash } from 'node:crypto';
import type { AuthorizationCodeExchangeRequest, TokenRefreshResponse } from '../../../types.ts';
import { isoNow, parseJson, PostgresAuthStore, stableHash } from '../../postgres-store.ts';

function s256(verifier: string) {
	return createHash('sha256').update(verifier).digest('base64url');
}

export async function exchangeAuthorizationCodeMethod(
	this: PostgresAuthStore,
	request: AuthorizationCodeExchangeRequest,
): Promise<TokenRefreshResponse> {
	await this.ensureInitialized();
	const codeHash = stableHash(request.code, this.config.authSecret);
	const row = await this.first<{
		id: string; client_id: string; user_id: string; redirect_uri: string; code_challenge: string;
		scopes_json: string; expires_at: string; used_at: string | null;
	}>(`SELECT * FROM oauth_authorization_codes WHERE code_hash = ?`, [codeHash]);
	if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()
		|| row.client_id !== request.clientId || row.redirect_uri !== request.redirectUri || s256(request.codeVerifier) !== row.code_challenge) {
		throw new Error('Authorization code is invalid, expired, used, or PKCE verification failed.');
	}
	const consumed = await this.first<{ id: string }>(`UPDATE oauth_authorization_codes
		SET used_at = ? WHERE id = ? AND used_at IS NULL RETURNING id`, [isoNow(), row.id]);
	if (!consumed) throw new Error('Authorization code replay detected.');
	return this.issueUserSession(row.user_id, {
		sessionType: 'authorization_code', scopes: parseJson<string[]>(row.scopes_json, []),
		data: { clientId: row.client_id, redirectUri: row.redirect_uri },
	});
}
