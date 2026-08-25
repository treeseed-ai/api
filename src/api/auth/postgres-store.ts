import { createHash,timingSafeEqual } from 'node:crypto';
import type { PostgresDatabaseLike } from '../types.ts';
import type { ApiConfig,ApiCredential,ApiPrincipal,DeviceCodeApproveRequest,DeviceCodePollRequest,DeviceCodePollResponse,DeviceCodeStartRequest,DeviceCodeStartResponse,TokenRefreshRequest,TokenRefreshResponse,TrustedUserAssertionClaims,UserIdentityProfileInput,} from '../types.ts';
import * as extractedMethods from "./postgres-store/methods.ts";
export function approvalUrl(baseUrl: string, userCode?: string | null) {
    const url = new URL('/auth/device/approve', `${baseUrl.replace(/\/+$/u, '')}/`);
    if (userCode) {
        url.searchParams.set('user_code', userCode);
    }
    return url.toString();
}
export const AUTH_SCHEMA_SQL = [
    `CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY,
		email TEXT,
		username TEXT UNIQUE,
		display_name TEXT,
		status TEXT NOT NULL DEFAULT 'active',
		metadata_json TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
    `CREATE TABLE IF NOT EXISTS user_identities (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		provider TEXT NOT NULL,
		provider_subject TEXT NOT NULL,
		email TEXT,
		email_verified INTEGER NOT NULL DEFAULT 0,
		profile_json TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_provider_subject
		ON user_identities(provider, provider_subject)`,
    `CREATE TABLE IF NOT EXISTS roles (
		id TEXT PRIMARY KEY,
		key TEXT NOT NULL UNIQUE,
		description TEXT,
		created_at TEXT NOT NULL
	)`,
    `CREATE TABLE IF NOT EXISTS permissions (
		id TEXT PRIMARY KEY,
		key TEXT NOT NULL UNIQUE,
		resource TEXT NOT NULL,
		action TEXT NOT NULL,
		scope TEXT NOT NULL,
		description TEXT,
		created_at TEXT NOT NULL
	)`,
    `CREATE TABLE IF NOT EXISTS role_permissions (
		role_id TEXT NOT NULL,
		permission_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		PRIMARY KEY (role_id, permission_id),
		FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
		FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
	)`,
    `CREATE TABLE IF NOT EXISTS user_role_bindings (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		role_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
		FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
	)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_role_bindings_user_role
		ON user_role_bindings(user_id, role_id)`,
    `CREATE TABLE IF NOT EXISTS api_tokens (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		name TEXT NOT NULL,
		token_prefix TEXT NOT NULL,
		token_hash TEXT NOT NULL,
		scopes_json TEXT NOT NULL,
		expires_at TEXT,
		last_used_at TEXT,
		revoked_at TEXT,
		metadata_json TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	)`,
    `CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id
		ON api_tokens(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_api_tokens_prefix
		ON api_tokens(token_prefix)`,
    `CREATE TABLE IF NOT EXISTS service_credentials (
		id TEXT PRIMARY KEY,
		service_id TEXT NOT NULL UNIQUE,
		name TEXT NOT NULL,
		secret_hash TEXT NOT NULL,
		roles_json TEXT NOT NULL,
		permissions_json TEXT NOT NULL,
		revoked_at TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		last_used_at TEXT
	)`,
    `CREATE TABLE IF NOT EXISTS auth_sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		session_type TEXT NOT NULL,
		access_token_hash TEXT NOT NULL,
		access_expires_at TEXT NOT NULL,
		refresh_token_hash TEXT NOT NULL,
		scopes_json TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		revoked_at TEXT,
		data_json TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	)`,
    `CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
		id TEXT PRIMARY KEY,
		code_hash TEXT NOT NULL UNIQUE,
		client_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		redirect_uri TEXT NOT NULL,
		code_challenge TEXT NOT NULL,
		scopes_json TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		used_at TEXT,
		created_at TEXT NOT NULL
	)`,
    `CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id
		ON auth_sessions(user_id)`,
    `CREATE TABLE IF NOT EXISTS operation_confirmation_nonces (
		nonce TEXT PRIMARY KEY,
		principal_id TEXT NOT NULL,
		client_id TEXT NOT NULL,
		operation_id TEXT NOT NULL,
		arguments_digest TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		consumed_at TEXT NOT NULL
	)`,
    `CREATE INDEX IF NOT EXISTS idx_operation_confirmation_nonces_expires_at
		ON operation_confirmation_nonces(expires_at)`,
    `CREATE TABLE IF NOT EXISTS audit_events (
		id TEXT PRIMARY KEY,
		actor_type TEXT NOT NULL,
		actor_id TEXT,
		event_type TEXT NOT NULL,
		target_type TEXT,
		target_id TEXT,
		data_json TEXT,
		created_at TEXT NOT NULL
	)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_events_target
		ON audit_events(target_type, target_id)`,
    `CREATE TABLE IF NOT EXISTS device_codes (
		id TEXT PRIMARY KEY,
		device_code_hash TEXT NOT NULL UNIQUE,
		user_code TEXT NOT NULL UNIQUE,
		client_id TEXT NOT NULL,
		requested_scopes_json TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		interval_seconds INTEGER NOT NULL,
		status TEXT NOT NULL,
		user_id TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
];
export type DeviceCodeRow = {
    id: string;
    device_code_hash: string;
    user_code: string;
    client_id: string;
    requested_scopes_json: string;
    expires_at: string;
    interval_seconds: number;
    status: string;
    user_id: string | null;
};
export type UserRow = {
    id: string;
    email: string | null;
    username: string | null;
    display_name: string | null;
    status: string;
    metadata_json: string | null;
    created_at: string;
    updated_at: string;
};
export type PrincipalRecord = {
    principal: ApiPrincipal;
    userId: string;
};
export interface PersonalAccessTokenResult {
    id: string;
    token: string;
    prefix: string;
    name: string;
    expiresAt: string | null;
}
export interface ServiceCredentialResult {
    id: string;
    serviceId: string;
    secret: string;
}
export function now() {
    return new Date();
}
export function isoNow() {
    return now().toISOString();
}
export function addSeconds(date: Date, seconds: number) {
    return new Date(date.getTime() + seconds * 1000);
}
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
    if (!value)
        return fallback;
    try {
        return JSON.parse(value) as T;
    }
    catch {
        return fallback;
    }
}
export function stableHash(value: string, secret: string) {
    return createHash('sha256').update(`${secret}:${value}`).digest('hex');
}
export function equalHash(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
export class PostgresAuthStore {
    initializationPromise: Promise<void> | null = null;
    constructor(readonly config: ApiConfig, readonly db: PostgresDatabaseLike) { }
}
export interface PostgresAuthStore {
    run(query: string, params?: unknown[]);
    first<T = Record<string, unknown>>(query: string, params?: unknown[]);
    all<T = Record<string, unknown>>(query: string, params?: unknown[]);
    ensureInitialized();
    ensureAuthSchema();
    seedCatalog();
    seedConfiguredServices();
    loadUser(userId: string);
    loadIdentityByProvider(provider: string, providerSubject: string);
    loadUserByVerifiedEmail(email: string);
    loadUserByUsername(username: string);
    canAdoptUsernameMatch(identity: UserIdentityProfileInput, user: UserRow | null);
    rolesForUser(userId: string);
    permissionsForUser(userId: string);
    permissionsForRoles(roleKeys: string[]);
    scopesForPrincipal(permissions: string[]);
    principalForUser(userId: string): Promise<PrincipalRecord>;
    assignRole(userId: string, roleKey: string);
    replaceRoles(userId: string, roleKeys: string[]);
    bootstrapRolesForUser(userId: string, identity: UserIdentityProfileInput);
    reconcileBootstrapAdmins(): Promise<void>;
    writeAuditEvent(input: {
        actorType: string;
        actorId: string | null;
        eventType: string;
        targetType: string | null;
        targetId: string | null;
        data?: Record<string, unknown>;
    });
    userMetadata(identity: UserIdentityProfileInput, existingUsername?: string | null);
    syncUser(identity: UserIdentityProfileInput);
    createUser(input: {
        email?: string | null;
        username?: string | null;
        displayName?: string | null;
        metadata?: Record<string, unknown>;
    });
    setUserRoles(userId: string, roles: string[]);
    startDeviceFlow(request: DeviceCodeStartRequest): Promise<DeviceCodeStartResponse>;
    approveDeviceFlow(request: DeviceCodeApproveRequest): Promise<{
        ok: true;
    }>;
    pollDeviceFlow(request: DeviceCodePollRequest): Promise<DeviceCodePollResponse>;
    issueUserSession(userId: string, options?: {
        sessionType?: string;
        scopes?: string[];
        data?: Record<string, unknown>;
    }): Promise<TokenRefreshResponse>;
    refreshAccessToken(request: TokenRefreshRequest): Promise<TokenRefreshResponse>;
    startAuthorizationCode(request: import('../types.ts').AuthorizationCodeStartRequest): Promise<import('../types.ts').AuthorizationCodeStartResponse>;
    exchangeAuthorizationCode(request: import('../types.ts').AuthorizationCodeExchangeRequest): Promise<TokenRefreshResponse>;
    revokeOAuthToken(token: string): Promise<void>;
    createPersonalAccessToken(userId: string, input: {
        name: string;
        scopes?: string[];
        expiresAt?: string | null;
    });
    listPersonalAccessTokens(userId: string);
    revokePersonalAccessToken(userId: string, tokenId: string);
    upsertServiceCredential(input: {
        serviceId: string;
        name: string;
        secret: string;
        roles?: string[];
        permissions?: string[];
    });
    createServiceCredential(input: {
        serviceId: string;
        name: string;
        roles?: string[];
        permissions?: string[];
    }): Promise<ServiceCredentialResult>;
    rotateServiceCredential(serviceId: string);
    authenticateBearerToken(token: string): Promise<{
        principal: ApiPrincipal;
        credential: ApiCredential;
    } | null>;
    authenticateService(serviceId: string, secret: string): Promise<{
        principal: ApiPrincipal;
        credential: ApiCredential;
    } | null>;
    exchangeTrustedUserAssertion(claims: TrustedUserAssertionClaims);
}
PostgresAuthStore.prototype.run = extractedMethods.runMethod;
PostgresAuthStore.prototype.first = extractedMethods.firstMethod;
PostgresAuthStore.prototype.all = extractedMethods.allMethod;
PostgresAuthStore.prototype.ensureInitialized = extractedMethods.ensureInitializedMethod;
PostgresAuthStore.prototype.ensureAuthSchema = extractedMethods.ensureAuthSchemaMethod;
PostgresAuthStore.prototype.seedCatalog = extractedMethods.seedCatalogMethod;
PostgresAuthStore.prototype.seedConfiguredServices = extractedMethods.seedConfiguredServicesMethod;
PostgresAuthStore.prototype.loadUser = extractedMethods.loadUserMethod;
PostgresAuthStore.prototype.loadIdentityByProvider = extractedMethods.loadIdentityByProviderMethod;
PostgresAuthStore.prototype.loadUserByVerifiedEmail = extractedMethods.loadUserByVerifiedEmailMethod;
PostgresAuthStore.prototype.loadUserByUsername = extractedMethods.loadUserByUsernameMethod;
PostgresAuthStore.prototype.canAdoptUsernameMatch = extractedMethods.canAdoptUsernameMatchMethod;
PostgresAuthStore.prototype.rolesForUser = extractedMethods.rolesForUserMethod;
PostgresAuthStore.prototype.permissionsForUser = extractedMethods.permissionsForUserMethod;
PostgresAuthStore.prototype.permissionsForRoles = extractedMethods.permissionsForRolesMethod;
PostgresAuthStore.prototype.scopesForPrincipal = extractedMethods.scopesForPrincipalMethod;
PostgresAuthStore.prototype.principalForUser = extractedMethods.principalForUserMethod;
PostgresAuthStore.prototype.assignRole = extractedMethods.assignRoleMethod;
PostgresAuthStore.prototype.replaceRoles = extractedMethods.replaceRolesMethod;
PostgresAuthStore.prototype.bootstrapRolesForUser = extractedMethods.bootstrapRolesForUserMethod;
PostgresAuthStore.prototype.reconcileBootstrapAdmins = extractedMethods.reconcileBootstrapAdminsMethod;
PostgresAuthStore.prototype.writeAuditEvent = extractedMethods.writeAuditEventMethod;
PostgresAuthStore.prototype.userMetadata = extractedMethods.userMetadataMethod;
PostgresAuthStore.prototype.syncUser = extractedMethods.syncUserMethod;
PostgresAuthStore.prototype.createUser = extractedMethods.createUserMethod;
PostgresAuthStore.prototype.setUserRoles = extractedMethods.setUserRolesMethod;
PostgresAuthStore.prototype.startDeviceFlow = extractedMethods.startDeviceFlowMethod;
PostgresAuthStore.prototype.approveDeviceFlow = extractedMethods.approveDeviceFlowMethod;
PostgresAuthStore.prototype.pollDeviceFlow = extractedMethods.pollDeviceFlowMethod;
PostgresAuthStore.prototype.issueUserSession = extractedMethods.issueUserSessionMethod;
PostgresAuthStore.prototype.refreshAccessToken = extractedMethods.refreshAccessTokenMethod;
PostgresAuthStore.prototype.startAuthorizationCode = extractedMethods.startAuthorizationCodeMethod;
PostgresAuthStore.prototype.exchangeAuthorizationCode = extractedMethods.exchangeAuthorizationCodeMethod;
PostgresAuthStore.prototype.revokeOAuthToken = extractedMethods.revokeOAuthTokenMethod;
PostgresAuthStore.prototype.createPersonalAccessToken = extractedMethods.createPersonalAccessTokenMethod;
PostgresAuthStore.prototype.listPersonalAccessTokens = extractedMethods.listPersonalAccessTokensMethod;
PostgresAuthStore.prototype.revokePersonalAccessToken = extractedMethods.revokePersonalAccessTokenMethod;
PostgresAuthStore.prototype.upsertServiceCredential = extractedMethods.upsertServiceCredentialMethod;
PostgresAuthStore.prototype.createServiceCredential = extractedMethods.createServiceCredentialMethod;
PostgresAuthStore.prototype.rotateServiceCredential = extractedMethods.rotateServiceCredentialMethod;
PostgresAuthStore.prototype.authenticateBearerToken = extractedMethods.authenticateBearerTokenMethod;
PostgresAuthStore.prototype.authenticateService = extractedMethods.authenticateServiceMethod;
PostgresAuthStore.prototype.exchangeTrustedUserAssertion = extractedMethods.exchangeTrustedUserAssertionMethod;
