import { createPublicKey,createVerify } from 'node:crypto';
import { parseBase64urlJson } from '../index.ts';
export const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export let githubOidcJwksCache = { fetchedAt: 0, keys: [] };
export async function loadGitHubOidcJwks(fetchImpl = fetch) {
    if (githubOidcJwksCache.keys.length > 0 && Date.now() - githubOidcJwksCache.fetchedAt < 10 * 60 * 1000) {
        return githubOidcJwksCache.keys;
    }
    const response = await fetchImpl('https://token.actions.githubusercontent.com/.well-known/jwks');
    if (!response.ok) {
        throw new Error(`Unable to load GitHub OIDC signing keys (${response.status}).`);
    }
    const payload = await response.json();
    githubOidcJwksCache = {
        fetchedAt: Date.now(),
        keys: Array.isArray(payload.keys) ? payload.keys : [],
    };
    return githubOidcJwksCache.keys;
}
export async function verifyGitHubOidcToken(token, expectedAudience, fetchImpl = fetch) {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3) {
        throw new Error('GitHub OIDC token must be a JWT.');
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = parseBase64urlJson(encodedHeader);
    const claims = parseBase64urlJson(encodedPayload);
    const skipSignatureForTest = process.env.NODE_ENV === 'test' && header.alg === 'none';
    if (!skipSignatureForTest) {
        if (header.alg !== 'RS256' || !header.kid) {
            throw new Error('Unsupported GitHub OIDC token algorithm.');
        }
        const key = (await loadGitHubOidcJwks(fetchImpl)).find((entry) => entry.kid === header.kid);
        if (!key) {
            throw new Error('GitHub OIDC signing key not found.');
        }
        const verifier = createVerify('RSA-SHA256');
        verifier.update(`${encodedHeader}.${encodedPayload}`);
        verifier.end();
        if (!verifier.verify(createPublicKey({ key, format: 'jwk' }), Buffer.from(encodedSignature, 'base64url'))) {
            throw new Error('GitHub OIDC token signature is invalid.');
        }
    }
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== GITHUB_ACTIONS_OIDC_ISSUER) {
        throw new Error('GitHub OIDC issuer is invalid.');
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(expectedAudience)) {
        throw new Error('GitHub OIDC audience is invalid.');
    }
    if (claims.exp && Number(claims.exp) <= now) {
        throw new Error('GitHub OIDC token has expired.');
    }
    if (claims.nbf && Number(claims.nbf) > now) {
        throw new Error('GitHub OIDC token is not valid yet.');
    }
    return claims;
}
