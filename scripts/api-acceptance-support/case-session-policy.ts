import { fetchWithTimeout } from './index.js';

export function caseNeedsIsolatedSession(caseSpec) {
    return caseSpec.descriptorId === 'post.v1.auth.logout'
        || caseSpec.sdkMethod === 'logout';
}

export interface AcceptanceActor extends Record<string, unknown> {
    id: string;
    email?: string;
    username?: string;
    token?: string;
}

export function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function actorForCase(caseSpec, actor, variables) {
    if (!caseNeedsIsolatedSession(caseSpec) || !actor?.email || !variables.seed?.password || !variables.baseUrl) {
        return actor;
    }
    const response = await fetchWithTimeout(`${variables.baseUrl}/v1/auth/web/sign-in`, {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'content-type': 'application/json',
        },
        body: JSON.stringify({ email: actor.email, password: variables.seed.password }),
    }, 'POST /v1/auth/web/sign-in isolated session');
    const envelope = await response.json().catch(() => null);
    const token = envelope?.payload?.accessToken;
    return response.ok && typeof token === 'string' && token.trim()
        ? { ...actor, token }
        : actor;
}
