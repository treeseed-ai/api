import {
	createHash,
	createPrivateKey,
	createPublicKey,
	createSign,
	generateKeyPairSync,
	randomUUID,
	type JsonWebKey,
	type KeyObject,
} from 'node:crypto';

export interface TreeDxDelegationScope {
	repositoryIds: string[];
	capabilities: string[];
	refs: string[];
	paths: string[];
}

export interface TreeDxDelegationInput {
	actorId: string;
	tenantId: string;
	projectId: string;
	connectionId: string;
	scope: TreeDxDelegationScope;
}

interface CachedDelegation { token: string; expiresAtEpoch: number; }

function base64Url(value: string | Buffer) {
	return Buffer.from(value).toString('base64url');
}

function normalizedPem(value: string | undefined) {
	return String(value ?? '').trim().replace(/\\n/gu, '\n');
}

function localDevelopment(environment: NodeJS.ProcessEnv) {
	if (environment.TREESEED_ENVIRONMENT === 'local' || environment.TREESEED_ENVIRONMENT === 'test' || environment.NODE_ENV === 'test' || environment.LOCAL_DEV_MODE === '1') return true;
	try {
		return ['localhost', '127.0.0.1', '::1'].includes(new URL(String(environment.TREESEED_API_BASE_URL ?? '')).hostname);
	} catch { return false; }
}

function keyMaterial(environment: NodeJS.ProcessEnv) {
	const configured = normalizedPem(environment.TREESEED_TREEDX_DELEGATION_PRIVATE_KEY);
	if (configured) return createPrivateKey(configured);
	if (!localDevelopment(environment)) {
		throw new Error('TREESEED_TREEDX_DELEGATION_PRIVATE_KEY is required outside local development.');
	}
	return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
}

function publicJwk(privateKey: KeyObject, requestedKeyId?: string): JsonWebKey {
	const exported = createPublicKey(privateKey).export({ format: 'jwk' });
	const thumbprint = createHash('sha256').update(JSON.stringify({ e: exported.e, kty: exported.kty, n: exported.n })).digest('hex').slice(0, 24);
	return { ...exported, alg: 'RS256', use: 'sig', kid: requestedKeyId?.trim() || `treedx-${thumbprint}` };
}

function unique(values: string[]) {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function canonicalScope(scope: TreeDxDelegationScope): TreeDxDelegationScope {
	return {
		repositoryIds: unique(scope.repositoryIds),
		capabilities: unique(scope.capabilities),
		refs: unique(scope.refs),
		paths: unique(scope.paths),
	};
}

export class TreeDxDelegationAuthority {
	readonly issuer: string;
	readonly audience: string;
	readonly currentJwk: JsonWebKey;
	private readonly privateKey: KeyObject;
	private readonly cache = new Map<string, CachedDelegation>();
	private readonly previousJwks: JsonWebKey[];

	constructor(environment: NodeJS.ProcessEnv = process.env) {
		this.privateKey = keyMaterial(environment);
		this.currentJwk = publicJwk(this.privateKey, environment.TREESEED_TREEDX_DELEGATION_KEY_ID);
		this.issuer = String(environment.TREESEED_TREEDX_JWT_ISSUER ?? 'https://api.treeseed.local/treedx').trim();
		this.audience = String(environment.TREESEED_TREEDX_JWT_AUDIENCE ?? 'treedx-local').trim();
		try {
			const parsed = JSON.parse(String(environment.TREESEED_TREEDX_DELEGATION_PREVIOUS_JWKS ?? '[]'));
			this.previousJwks = Array.isArray(parsed) ? parsed.filter((value): value is JsonWebKey => value?.kty === 'RSA' && typeof value.kid === 'string') : [];
		} catch { throw new Error('TREESEED_TREEDX_DELEGATION_PREVIOUS_JWKS must be a JSON array of public JWKs.'); }
	}

	jwks() {
		return { keys: [this.currentJwk, ...this.previousJwks] };
	}

	mint(input: TreeDxDelegationInput, nowEpochSeconds = Math.floor(Date.now() / 1000)) {
		const scope = canonicalScope(input.scope);
		const cacheKey = JSON.stringify({ ...input, scope, issuer: this.issuer, audience: this.audience, kid: this.currentJwk.kid });
		const cached = this.cache.get(cacheKey);
		if (cached && cached.expiresAtEpoch - 30 > nowEpochSeconds) return cached;
		const expiresAtEpoch = nowEpochSeconds + 120;
		const claims = {
			iss: this.issuer,
			aud: this.audience,
			sub: input.actorId,
			iat: nowEpochSeconds - 5,
			exp: expiresAtEpoch,
			jti: randomUUID(),
			treedx_actor_id: input.actorId,
			treedx_tenant_id: input.tenantId,
			treedx_repo_ids: scope.repositoryIds,
			treedx_capabilities: scope.capabilities,
			treedx_refs: scope.refs,
			treedx_paths: scope.paths,
			treeseed_project_id: input.projectId,
			treeseed_connection_id: input.connectionId,
		};
		const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: this.currentJwk.kid }));
		const payload = base64Url(JSON.stringify(claims));
		const unsigned = `${header}.${payload}`;
		const signer = createSign('RSA-SHA256');
		signer.update(unsigned);
		signer.end();
		const result = { token: `${unsigned}.${signer.sign(this.privateKey, 'base64url')}`, expiresAtEpoch };
		this.cache.set(cacheKey, result);
		return result;
	}
}

let processAuthority: TreeDxDelegationAuthority | undefined;

export function treeDxDelegationAuthority() {
	processAuthority ??= new TreeDxDelegationAuthority(process.env);
	return processAuthority;
}
