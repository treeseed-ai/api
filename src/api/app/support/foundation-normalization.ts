export function parseBooleanEnvValue(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized)
        return null;
    if (['1', 'true', 'yes', 'on'].includes(normalized))
        return true;
    if (['0', 'false', 'no', 'off'].includes(normalized))
        return false;
    return null;
}
export function normalizeUsername(value) {
    return String(value ?? '').trim().toLowerCase();
}
export function parseJsonObject(value, fallback: any = {}) {
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
export function normalizeBaseUrl(baseUrl) {
    return String(baseUrl ?? '').trim().replace(/\/+$/u, '');
}
export function normalizeMarketProfile(value, fallbackTeamId = null) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : null;
    const baseUrl = typeof value.baseUrl === 'string' && value.baseUrl.trim() ? normalizeBaseUrl(value.baseUrl) : null;
    if (!id || !baseUrl) {
        return null;
    }
    return {
        id,
        label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : id,
        baseUrl,
        kind: value.kind === 'central' ? 'central' : 'specialized',
        teamId: typeof value.teamId === 'string' && value.teamId.trim() ? value.teamId.trim() : fallbackTeamId,
        alwaysAvailable: value.alwaysAvailable === true || value.kind === 'central',
    };
}
export function parseBase64urlJson(value) {
    return JSON.parse(Buffer.from(String(value ?? ''), 'base64url').toString('utf8'));
}
