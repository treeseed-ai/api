import { createPublicKey,createVerify } from 'node:crypto';
import { parseBase64urlJson,providerJwksCache } from '../../index.ts';
export const POSTGRES_AUTH_PROVIDER_ID = 'market-postgres';
export const AUTH_PROVIDERS = {
    github: { label: 'GitHub', authorizeUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', scopes: 'read:user user:email' },
    google: { label: 'Google', authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scopes: 'openid email profile', issuer: 'https://accounts.google.com', jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs' },
    microsoft: { label: 'Microsoft', authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scopes: 'openid email profile User.Read', issuerPrefix: 'https://login.microsoftonline.com/', jwksUrl: 'https://login.microsoftonline.com/common/discovery/v2.0/keys' },
    apple: { label: 'Apple', authorizeUrl: 'https://appleid.apple.com/auth/authorize', tokenUrl: 'https://appleid.apple.com/auth/token', scopes: 'name email', issuer: 'https://appleid.apple.com', jwksUrl: 'https://appleid.apple.com/auth/keys' },
};
export async function verifyProviderIdToken(token, configured, expectedNonce) {
    const [encodedHeader, encodedPayload, encodedSignature] = String(token ?? '').split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature)
        throw new Error('The identity provider did not return a valid identity token.');
    const header = parseBase64urlJson(encodedHeader);
    const claims = parseBase64urlJson(encodedPayload);
    if (header.alg !== 'RS256' || !header.kid)
        throw new Error('The identity provider used an unsupported token algorithm.');
    let cached = providerJwksCache.get(configured.jwksUrl);
    if (!cached || cached.expiresAt <= Date.now()) {
        const response = await fetch(configured.jwksUrl, { headers: { accept: 'application/json' } });
        if (!response.ok)
            throw new Error('The identity provider signing keys are unavailable.');
        const payload = await response.json();
        cached = { keys: Array.isArray(payload.keys) ? payload.keys : [], expiresAt: Date.now() + 10 * 60000 };
        providerJwksCache.set(configured.jwksUrl, cached);
    }
    const key = cached.keys.find((entry) => entry.kid === header.kid);
    if (!key)
        throw new Error('The identity provider signing key was not found.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    if (!verifier.verify(createPublicKey({ key, format: 'jwk' }), Buffer.from(encodedSignature, 'base64url')))
        throw new Error('The identity provider token signature is invalid.');
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(configured.clientId))
        throw new Error('The identity provider token audience is invalid.');
    if (configured.issuer && claims.iss !== configured.issuer && !(configured.issuer === 'https://accounts.google.com' && claims.iss === 'accounts.google.com'))
        throw new Error('The identity provider token issuer is invalid.');
    if (configured.issuerPrefix && (!String(claims.iss ?? '').startsWith(configured.issuerPrefix) || !String(claims.iss).endsWith('/v2.0')))
        throw new Error('The identity provider token issuer is invalid.');
    if (!claims.exp || Number(claims.exp) <= Math.floor(Date.now() / 1000))
        throw new Error('The identity provider token has expired.');
    if (!claims.nonce || claims.nonce !== expectedNonce)
        throw new Error('The identity provider nonce was not accepted.');
    return claims;
}
