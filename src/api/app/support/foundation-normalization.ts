export function parseBooleanEnvValue(value: unknown) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized)
        return null;
    if (['1', 'true', 'yes', 'on'].includes(normalized))
        return true;
    if (['0', 'false', 'no', 'off'].includes(normalized))
        return false;
    return null;
}
export function normalizeUsername(value: unknown) {
    return String(value ?? '').trim().toLowerCase();
}
export function parseJsonObject(value: unknown, fallback: any = {}) {
    if (!value)
        return fallback;
    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    }
    catch {
        return fallback;
    }
}
export function normalizeBaseUrl(baseUrl: unknown) {
    return String(baseUrl ?? '').trim().replace(/\/+$/u, '');
}
export function parseBase64urlJson(value: unknown) {
    return JSON.parse(Buffer.from(String(value ?? ''), 'base64url').toString('utf8'));
}
