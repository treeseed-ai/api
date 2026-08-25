import { isLoopbackUrl,normalizeBaseUrl,optionalTrimmedString,requestClientIp,trimmedHeaderValue } from '../index.ts';
export function shouldExposeNonProductionAuthDiagnostics(c, runtime) {
    const environment = String(runtime?.resolved?.config?.environment ?? process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? '').trim().toLowerCase();
    if (environment && !['prod', 'production'].includes(environment))
        return true;
    try {
        const host = new URL(c.req.url).hostname.toLowerCase();
        return host.includes('staging') || host.endsWith('.localhost') || host === 'localhost' || host === '127.0.0.1' || host === '::1';
    }
    catch {
        return false;
    }
}
export function requestSessionMetadata(c) {
    const userAgent = trimmedHeaderValue(c, 'user-agent');
    const ipAddress = requestClientIp(c);
    return {
        ipAddress: ipAddress ? ipAddress.slice(0, 128) : null,
        userAgent: userAgent ? userAgent.slice(0, 512) : null,
    };
}
export function webSessionData(c, source) {
    return {
        source,
        ...requestSessionMetadata(c),
    };
}
export function controlPlaneAuthContext(c, config: any = {}) {
    const configuredSiteUrl = String(config.siteUrl ?? config.authApprovalBaseUrl ?? '').trim();
    return {
        locals: {
            runtime: {
                env: {
                    ...process.env,
                    ...(c.env ?? {}),
                    ...(configuredSiteUrl ? { TREESEED_SITE_URL: configuredSiteUrl } : {}),
                },
            },
        },
        url: new URL(c.req.url),
    };
}
export function authTokenTimestampSeconds(value = Date.now()) {
    return Math.floor(Number(value) / 1000);
}
export function authTokenTimestampMillis(value) {
    const number = Number(value ?? 0);
    if (!Number.isFinite(number) || number <= 0)
        return 0;
    return number < 10000000000 ? number * 1000 : number;
}
export function webAuthPayload(session) {
    return {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        tokenType: session.tokenType,
        expiresAt: session.expiresAt,
        expiresInSeconds: session.expiresInSeconds,
        principal: session.principal,
    };
}
export function normalizeAppearancePreference(input: any = {}) {
    const scheme = optionalTrimmedString(input.colorScheme ?? input.scheme) ?? 'fern';
    const mode = optionalTrimmedString(input.themeMode ?? input.mode) ?? 'system';
    const workspace = input.workspace && typeof input.workspace === 'object' ? input.workspace : {};
    const workspaceScheme = optionalTrimmedString(input.contentThemeOverlayScheme ?? workspace.scheme) ?? scheme;
    const workspaceMode = optionalTrimmedString(input.contentThemeOverlayMode ?? workspace.mode) ?? 'inherit';
    const enabledValue = input.contentThemeOverlayEnabled ?? workspace.enabled;
    return {
        scheme,
        mode: ['light', 'dark', 'system'].includes(mode) ? mode : 'system',
        workspace: {
            enabled: enabledValue === true || enabledValue === 'true' || enabledValue === '1',
            scheme: workspaceScheme,
            mode: ['inherit', 'light', 'dark', 'system'].includes(workspaceMode) ? workspaceMode : 'inherit',
        },
    };
}
export function resolveAuthApprovalBaseUrl(config) {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const configured = normalizeBaseUrl(config.authApprovalBaseUrl ?? config.siteUrl ?? '');
    const remoteApi = baseUrl && !isLoopbackUrl(baseUrl);
    if (configured) {
        if (remoteApi && isLoopbackUrl(configured)) {
            throw new Error(`Refusing loopback device approval URL "${configured}" for remote API "${baseUrl}".`);
        }
        return configured;
    }
    const environment = normalizeBaseUrl(process.env.TREESEED_SITE_URL ?? process.env.TREESEED_BETTER_AUTH_URL ?? '');
    if (remoteApi && environment && isLoopbackUrl(environment)) {
        throw new Error(`Refusing loopback device approval URL "${environment}" for remote API "${baseUrl}".`);
    }
    const candidate = environment || baseUrl;
    const normalized = normalizeBaseUrl(candidate);
    if (normalized === 'https://api.treeseed.dev') {
        return 'https://treeseed.dev';
    }
    return normalized || baseUrl;
}
