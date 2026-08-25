import { getSiteAuthConfig } from '../../../../auth/config.ts';
import { hashControlPlanePassword, validateControlPlanePassword, verifyControlPlanePassword } from '../../../auth/password.ts';

export { hashControlPlanePassword, validateControlPlanePassword, verifyControlPlanePassword } from '../../../auth/password.ts';
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
export function passwordResetUrlFor(context, token) {
    const authConfig = getSiteAuthConfig(context);
    const target = new URL('/auth/reset-password', `${authConfig.siteBaseUrl.replace(/\/+$/u, '')}/`);
    target.searchParams.set('token', token);
    return target.toString();
}
