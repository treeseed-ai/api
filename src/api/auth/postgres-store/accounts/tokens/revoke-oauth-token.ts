import { PostgresAuthStore, isoNow, stableHash } from '../../../postgres-store.ts';

export async function revokeOAuthTokenMethod(this: PostgresAuthStore, token: string): Promise<void> {
	await this.ensureInitialized();
	const hash = stableHash(token, this.config.authSecret);
	const timestamp = isoNow();
	await this.run(`UPDATE auth_sessions
		SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
		WHERE access_token_hash = ? OR refresh_token_hash = ?`, [timestamp, timestamp, hash, hash]);
	await this.run(`UPDATE api_tokens
		SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
		WHERE token_hash = ? AND kind <> 'personal_access_token'`, [timestamp, timestamp, hash]);
}
