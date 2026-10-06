import { verifyProviderIdToken } from '../index.ts';
import type { JsonWebKey } from 'node:crypto';
import type { providerConfigFor } from '../configuration/foundation-configuration.ts';
export const providerJwksCache = new Map<string, { keys: Array<JsonWebKey & { kid?: string }>; expiresAt: number }>();
export async function exchangeProviderIdentity(...[provider, configured, code, redirectUri, verifier, expectedNonce]:
    | [provider: 'github', configured: NonNullable<ReturnType<typeof providerConfigFor>>, code: string, redirectUri: string, verifier: string | null | undefined, expectedNonce: string]
    | [provider: 'google' | 'microsoft' | 'apple', configured: Extract<NonNullable<ReturnType<typeof providerConfigFor>>, { jwksUrl: string }>, code: string, redirectUri: string, verifier: string | null | undefined, expectedNonce: string]) {
    const body = new URLSearchParams({ code, client_id: configured.clientId, client_secret: configured.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
    if (verifier)
        body.set('code_verifier', verifier);
    const tokenResponse = await fetch(configured.tokenUrl, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body });
    const tokens = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokens.access_token)
        throw new Error('The identity provider did not accept the authorization response.');
    const claims = provider === 'github' ? {} : await verifyProviderIdToken(tokens.id_token, configured, expectedNonce);
    if (provider === 'github') {
        const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${tokens.access_token}`, 'user-agent': 'TreeSeed' };
        const [userResponse, emailsResponse] = await Promise.all([fetch('https://api.github.com/user', { headers }), fetch('https://api.github.com/user/emails', { headers })]);
        const user = await userResponse.json();
        const emails = await emailsResponse.json().catch(() => []);
        const email = emails.find?.((entry: { primary?: boolean; verified?: boolean; email?: string }) => entry.primary && entry.verified)?.email ?? user.email;
        return { subject: String(user.id), email, emailVerified: Boolean(email), displayName: user.name ?? user.login, profile: { image: user.avatar_url } };
    }
    if (provider === 'microsoft') {
        const response = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { authorization: `Bearer ${tokens.access_token}` } });
        const user = await response.json();
        return { subject: String(user.id), email: user.mail ?? user.userPrincipalName, emailVerified: true, displayName: user.displayName };
    }
    return { subject: String(claims.sub ?? ''), email: claims.email, emailVerified: claims.email_verified === true || claims.email_verified === 'true', displayName: claims.name ?? claims.email };
}
