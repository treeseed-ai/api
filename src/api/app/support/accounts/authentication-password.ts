import { pbkdf2Sync,randomBytes,timingSafeEqual } from 'node:crypto';
import { getSiteAuthConfig } from '../../../../auth/config.ts';
export async function consumeReauthentication(store, principal, action, body) {
    const credential = await store.first(`SELECT password_hash FROM control_plane_auth_credentials WHERE user_id = ? AND status = 'active' LIMIT 1`, [principal.id]);
    if (credential && typeof body.currentPassword === 'string' && verifyControlPlanePassword(body.currentPassword, credential.password_hash))
        return true;
    const grantId = String(body.reauthenticationGrantId ?? '');
    const sessionId = String(principal.metadata?.sessionId ?? '');
    if (!grantId || !sessionId)
        return false;
    const grant = await store.first(`SELECT * FROM auth_reauthentication_grants WHERE id = ? AND user_id = ? AND session_id = ? AND action = ? AND consumed_at IS NULL LIMIT 1`, [grantId, principal.id, sessionId, action]);
    if (!grant || new Date(grant.expires_at).getTime() <= Date.now())
        return false;
    await store.run(`UPDATE auth_reauthentication_grants SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`, [new Date().toISOString(), grant.id]);
    return true;
}
export function validateControlPlanePassword(value) {
    return typeof value === 'string' && value.length >= 12;
}
export function hashControlPlanePassword(password) {
    const salt = randomBytes(16).toString('base64url');
    const iterations = 210000;
    const digest = pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64url');
    return `pbkdf2-sha256$${iterations}$${salt}$${digest}`;
}
export function verifyControlPlanePassword(password, envelope) {
    const [algorithm, iterationsValue, salt, expected] = String(envelope ?? '').split('$');
    if (algorithm !== 'pbkdf2-sha256' || !iterationsValue || !salt || !expected)
        return false;
    const iterations = Number(iterationsValue);
    if (!Number.isFinite(iterations) || iterations <= 0)
        return false;
    const actual = pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64url');
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}
export function passwordResetUrlFor(context, token) {
    const authConfig = getSiteAuthConfig(context);
    const target = new URL('/auth/reset-password', `${authConfig.siteBaseUrl.replace(/\/+$/u, '')}/`);
    target.searchParams.set('token', token);
    return target.toString();
}
