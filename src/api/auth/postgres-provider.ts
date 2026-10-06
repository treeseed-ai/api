import { createHmac,timingSafeEqual } from 'node:crypto';
import type { PostgresDatabaseLike } from '../types.ts';
import type {
ApiAuthProvider,
ApiConfig,
ApiCredential,
ApiPrincipal,
AuthorizationCodeExchangeRequest,
AuthorizationCodeStartRequest,
DeviceCodeApproveRequest,
DeviceCodeApprovalPresentationRequest,
DeviceCodePollRequest,
DeviceCodePollResponse,
DeviceCodeStartRequest,
DeviceCodeStartResponse,
TokenRefreshRequest,
TokenRefreshResponse,
TrustedUserAssertionClaims,
UserIdentityProfileInput,
} from '../types.ts';
import { PostgresAuthStore } from './postgres-store.ts';
import { verifyControlPlanePassword } from './password.ts';

function encodePayload(payload: TrustedUserAssertionClaims) {
	return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodePayload(value: string) {
	return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as TrustedUserAssertionClaims;
}

function signPayload(payload: string, secret: string) {
	return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(left: string, right: string) {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class PostgresAuthProvider implements ApiAuthProvider {
	readonly id = 'control-plane-postgres';
	private readonly store: PostgresAuthStore;

	constructor(
		private readonly config: ApiConfig,
		options: { db?: PostgresDatabaseLike } = {},
	) {
		if (!options.db) {
			throw new Error('PostgresAuthProvider requires an explicit database binding or adapter.');
		}
		this.store = new PostgresAuthStore(config, options.db);
	}

	startDeviceFlow(request: DeviceCodeStartRequest): Promise<DeviceCodeStartResponse> {
		return this.store.startDeviceFlow(request);
	}

	pollDeviceFlow(request: DeviceCodePollRequest): Promise<DeviceCodePollResponse> {
		return this.store.pollDeviceFlow(request);
	}

	refreshAccessToken(request: TokenRefreshRequest): Promise<TokenRefreshResponse> {
		return this.store.refreshAccessToken(request);
	}

	startAuthorizationCode(request: AuthorizationCodeStartRequest) {
		return this.store.startAuthorizationCode(request);
	}

	exchangeAuthorizationCode(request: AuthorizationCodeExchangeRequest): Promise<TokenRefreshResponse> {
		return this.store.exchangeAuthorizationCode(request);
	}

	revokeOAuthToken(token: string): Promise<void> {
		return this.store.revokeOAuthToken(token);
	}

	issueUserSession(userId: string, options: { sessionType?: string; scopes?: string[]; data?: Record<string, unknown> } = {}) {
		return this.store.issueUserSession(userId, options);
	}

	approveDeviceFlow(request: DeviceCodeApproveRequest): Promise<{ ok: true }> {
		return this.store.approveDeviceFlow(request);
	}

	describeDeviceFlow(request: DeviceCodeApprovalPresentationRequest) {
		return this.store.describeDeviceFlow(request);
	}

	async authenticatePassword(identifier: string, password: string): Promise<{ principal: ApiPrincipal } | null> {
		const normalized = identifier.trim();
		if (!normalized || !password) return null;
		await this.store.ensureInitialized();
		const credential = await this.store.first<{ user_id: string; password_hash: string }>(`SELECT user_id, password_hash
			FROM control_plane_auth_credentials
			WHERE status = 'active' AND (LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?))
			LIMIT 1`, [normalized, normalized]);
		if (!credential || !verifyControlPlanePassword(password, credential.password_hash)) return null;
		return { principal: (await this.store.principalForUser(credential.user_id)).principal };
	}

	authenticateBearerToken(token: string): Promise<{ principal: ApiPrincipal; credential: ApiCredential } | null> {
		return this.store.authenticateBearerToken(token);
	}

	authenticateServiceCredential(serviceId: string, secret: string): Promise<{ principal: ApiPrincipal; credential: ApiCredential } | null> {
		return this.store.authenticateService(serviceId, secret);
	}

	createPersonalAccessToken(userId: string, input: { name: string; scopes?: string[]; expiresAt?: string | null }) {
		return this.store.createPersonalAccessToken(userId, input);
	}

	listPersonalAccessTokens(userId: string) {
		return this.store.listPersonalAccessTokens(userId);
	}

	revokePersonalAccessToken(userId: string, tokenId: string) {
		return this.store.revokePersonalAccessToken(userId, tokenId);
	}

	syncUserIdentity(identity: UserIdentityProfileInput) {
		return this.store.syncUser(identity);
	}

	createUser(input: { email?: string | null; username?: string | null; displayName?: string | null; metadata?: Record<string, unknown> }) {
		return this.store.createUser(input);
	}

	setUserRoles(userId: string, roles: string[]) {
		return this.store.setUserRoles(userId, roles);
	}

	createServiceToken(input: { serviceId: string; name: string; roles?: string[]; permissions?: string[] }) {
		return this.store.createServiceCredential(input);
	}

	rotateServiceToken(serviceId: string) {
		return this.store.rotateServiceCredential(serviceId);
	}

	createTrustedUserAssertion(claims: TrustedUserAssertionClaims) {
		const payload = encodePayload(claims);
		const signature = signPayload(payload, this.config.webAssertionSecret);
		return `${payload}.${signature}`;
	}

	verifyTrustedUserAssertion(assertion: string) {
		const [payload, signature] = assertion.split('.');
		if (!payload || !signature) return null;
		const expectedSignature = signPayload(payload, this.config.webAssertionSecret);
		if (!safeEqual(signature, expectedSignature)) return null;
		const claims = decodePayload(payload);
		if (!claims.expiresAt || new Date(claims.expiresAt).getTime() <= Date.now()) {
			return null;
		}
		return claims;
	}

	exchangeTrustedUserAssertion(claims: TrustedUserAssertionClaims) {
		return this.store.exchangeTrustedUserAssertion(claims);
	}
}
