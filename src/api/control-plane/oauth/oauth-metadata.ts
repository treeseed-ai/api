export const TREESEED_OAUTH_SCOPES = [
	'treeseed:read',
	'treeseed:knowledge:write',
	'treeseed:governance:write',
	'treeseed:projects:write',
	'treeseed:execution',
	'treeseed:admin',
] as const;

export const TREESEED_FIRST_PARTY_OAUTH_CLIENTS = ['trsd'] as const;

export function isFirstPartyOAuthClient(value: string) {
	return TREESEED_FIRST_PARTY_OAUTH_CLIENTS.includes(value as typeof TREESEED_FIRST_PARTY_OAUTH_CLIENTS[number]);
}

export function oauthIssuer(requestUrl: string) {
	const url = new URL(requestUrl);
	return `${url.protocol}//${url.host}`;
}

export function protectedResourceMetadata(requestUrl: string) {
	const issuer = oauthIssuer(requestUrl);
	return {
		resource: `${issuer}/mcp`,
		authorization_servers: [issuer],
		bearer_methods_supported: ['header'],
		scopes_supported: [...TREESEED_OAUTH_SCOPES],
		resource_documentation: `${issuer}/docs`,
	};
}

export function authorizationServerMetadata(requestUrl: string) {
	const issuer = oauthIssuer(requestUrl);
	return {
		issuer,
		authorization_endpoint: `${issuer}/oauth/authorize`,
		device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
		token_endpoint: `${issuer}/oauth/token`,
		revocation_endpoint: `${issuer}/oauth/revoke`,
		grant_types_supported: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
		response_types_supported: ['code'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none'],
		scopes_supported: [...TREESEED_OAUTH_SCOPES],
	};
}

export function normalizeRequestedScopes(value: unknown) {
	const requested = (Array.isArray(value) ? value.map(String) : String(value ?? '').split(/\s+/u))
		.map((scope) => scope.trim())
		.filter(Boolean);
	const scopes = requested.length > 0 ? [...new Set(requested)] : ['treeseed:read'];
	const unsupported = scopes.filter((scope) => !TREESEED_OAUTH_SCOPES.includes(scope as typeof TREESEED_OAUTH_SCOPES[number]));
	return { scopes, unsupported };
}
