import { resolveApiConfig } from '../../../configuration/runtime-config.ts';
import { getSiteAuthConfig } from '../../../../auth/config.ts';
import { AUTH_PROVIDERS,jsonError,controlPlaneAuthContext } from '../index.ts';
export function providerConfigFor(c, provider) {
    const config = getSiteAuthConfig(controlPlaneAuthContext(c));
    const spec = AUTH_PROVIDERS[provider];
    const credentials = config.providers?.[provider];
    return spec && credentials?.clientId && credentials?.clientSecret ? { ...spec, ...credentials } : null;
}
export function mergeStringConfig(target, config) {
    for (const [key, value] of Object.entries(config ?? {})) {
        if (typeof value === 'string' && value.trim())
            target[key] = value;
    }
    return target;
}
export function requireConfiguredServiceCredential(c, config) {
    const serviceId = c.req.header('x-treeseed-service-id') ?? '';
    const serviceSecret = c.req.header('x-treeseed-service-secret') ?? '';
    if (!config.webServiceId || !config.webServiceSecret || serviceId !== config.webServiceId || serviceSecret !== config.webServiceSecret) {
        return {
            response: jsonError(c, 401, 'Trusted Treeseed service credential required.'),
        };
    }
    return { ok: true };
}
export function defaultConfig(overrides: any = {}) {
    const resolved = resolveApiConfig();
    const config = {
        ...resolved,
        projectId: overrides.projectId ?? resolved.projectId ?? 'treeseed-api',
        repoRoot: overrides.repoRoot ?? resolved.repoRoot ?? process.cwd(),
        d1DatabaseId: undefined,
        d1DatabaseName: undefined,
        d1LocalPersistTo: undefined,
        d1WranglerConfigPath: undefined,
        ...overrides,
    };
    if (overrides.authApprovalBaseUrl == null && typeof overrides.siteUrl === 'string' && overrides.siteUrl.trim()) {
        config.authApprovalBaseUrl = overrides.siteUrl.trim();
    }
    return config;
}
