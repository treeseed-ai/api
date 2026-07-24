

export function actorHeaders(actor: any = {}) {
    const headers = new Headers(actor.headers ?? {});
    if (actor.token) {
        headers.set('authorization', `Bearer ${actor.token}`);
    }
    if (!actor.token && actor.tokenEnv) {
        const token = process.env[actor.tokenEnv];
        if (!token && actor.required === false)
            return null;
        if (!token)
            throw new Error(`Actor ${actor.id ?? actor.tokenEnv} requires env ${actor.tokenEnv}`);
        headers.set('authorization', `Bearer ${token}`);
    }
    return headers;
}

export async function loadMarketClient() {
    return import('@treeseed/sdk/market-client');
}

export function serviceHeaders(spec) {
    const environment = process.env.TREESEED_ACCEPTANCE_ENVIRONMENT || process.env.TREESEED_ENVIRONMENT || 'local';
    const serviceId = process.env[spec.seed?.serviceIdEnv ?? 'TREESEED_ACCEPTANCE_SERVICE_ID']
        ?? (environment === 'local' ? process.env.TREESEED_API_WEB_SERVICE_ID ?? process.env.TREESEED_WEB_SERVICE_ID ?? 'web' : undefined);
    const serviceSecret = process.env[spec.seed?.serviceSecretEnv ?? 'TREESEED_ACCEPTANCE_SERVICE_SECRET']
        ?? (environment === 'local'
            ? process.env.TREESEED_API_WEB_SERVICE_SECRET ?? process.env.TREESEED_WEB_SERVICE_SECRET ?? 'treeseed-web-service-dev-secret'
            : undefined);
    if (!serviceId || !serviceSecret) {
        throw new Error('Acceptance seeding requires TREESEED_ACCEPTANCE_SERVICE_ID and TREESEED_ACCEPTANCE_SERVICE_SECRET.');
    }
    return {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-treeseed-service-id': serviceId,
        'x-treeseed-service-secret': serviceSecret,
    };
}

export function optionalAcceptanceServiceHeaders() {
    const serviceId = process.env.TREESEED_ACCEPTANCE_SERVICE_ID;
    const serviceSecret = process.env.TREESEED_ACCEPTANCE_SERVICE_SECRET;
    if (!serviceId || !serviceSecret)
        return {};
    return {
        'x-treeseed-service-id': serviceId,
        'x-treeseed-service-secret': serviceSecret,
        'x-treeseed-acceptance-email-bypass': '1',
    };
}

export function addOptionalAcceptanceServiceHeaders(headers, options: any = {}) {
    if (options.environment === 'local' || options.enabled === false)
        return headers;
    for (const [key, value] of Object.entries(optionalAcceptanceServiceHeaders())) {
        headers.set(key, value);
    }
    return headers;
}

export function usesHostedAcceptanceEmailBypass(caseSpec, environment) {
    if (environment === 'local')
        return false;
    if (caseSpec?.expect?.mailpit)
        return true;
    return [
        'webSignUp',
        'addWebEmail',
        'requestWebPasswordReset',
    ].includes(caseSpec?.sdkMethod);
}
