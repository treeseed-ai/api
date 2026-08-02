import { createHash } from 'node:crypto';
import { verifyProviderIdToken } from '../index.ts';
export const availabilityAttempts = new Map();
export const providerJwksCache = new Map();
export function availabilityRateLimit(c, kind, value) {
    const key = `${kind}:${c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'local'}:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
    const now = Date.now();
    const current = availabilityAttempts.get(key);
    const source = { ...process.env, ...(c.env ?? {}) };
    const windowMs = Math.max(1000, Number(source.TREESEED_AUTH_AVAILABILITY_WINDOW_MS ?? 60000) || 60000);
    const limit = Math.max(1, Number(source.TREESEED_AUTH_AVAILABILITY_LIMIT ?? 10) || 10);
    const next = !current || current.resetAt <= now ? { count: 1, resetAt: now + windowMs } : { ...current, count: current.count + 1 };
    availabilityAttempts.set(key, next);
    return next.count > limit ? Math.max(1, Math.ceil((next.resetAt - now) / 1000)) : 0;
}
export async function exchangeProviderIdentity(provider, configured, code, redirectUri, verifier, expectedNonce) {
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
        const email = emails.find?.((entry) => entry.primary && entry.verified)?.email ?? user.email;
        return { subject: String(user.id), email, emailVerified: Boolean(email), displayName: user.name ?? user.login, profile: { image: user.avatar_url } };
    }
    if (provider === 'microsoft') {
        const response = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { authorization: `Bearer ${tokens.access_token}` } });
        const user = await response.json();
        return { subject: String(user.id), email: user.mail ?? user.userPrincipalName, emailVerified: true, displayName: user.displayName };
    }
    return { subject: String(claims.sub ?? ''), email: claims.email, emailVerified: claims.email_verified === true || claims.email_verified === 'true', displayName: claims.name ?? claims.email };
}
