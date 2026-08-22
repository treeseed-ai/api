import { randomUUID } from 'node:crypto';
import type { AuthorizationCodeStartRequest, AuthorizationCodeStartResponse } from '../../../types.ts';
import { addSeconds, isoNow, PostgresAuthStore, stableHash } from '../../postgres-store.ts';
import { nextOpaqueToken } from '../../tokens.ts';

export async function startAuthorizationCodeMethod(
	this: PostgresAuthStore,
	request: AuthorizationCodeStartRequest,
): Promise<AuthorizationCodeStartResponse> {
	await this.ensureInitialized();
	const code = nextOpaqueToken('code');
	const expiresInSeconds = Math.min(this.config.webExchangeTtlSeconds, 600);
	const createdAt = isoNow();
	await this.run(`INSERT INTO oauth_authorization_codes
		(id, code_hash, client_id, user_id, redirect_uri, code_challenge, scopes_json, expires_at, used_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`, [
		randomUUID(), stableHash(code, this.config.authSecret), request.clientId, request.userId, request.redirectUri,
		request.codeChallenge, JSON.stringify(request.scopes), addSeconds(new Date(createdAt), expiresInSeconds).toISOString(), createdAt,
	]);
	return { code, expiresInSeconds };
}
