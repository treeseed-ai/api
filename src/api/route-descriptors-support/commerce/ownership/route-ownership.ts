

export function routeId(method, path) {
    return [
        method.toLowerCase(),
        ...path
            .replace(/^\/+/u, '')
            .split('/')
            .filter(Boolean)
            .map((part) => part.startsWith(':') ? part.slice(1) : part)
            .map((part) => part.replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-+|-+$/gu, ''))
            .filter(Boolean),
    ].join('.');
}

export function isTreeDxCredentialBridgePath(path) {
    return path === '/v1/internal/treedx/credentials/github';
}

export function ownerDomain(path) {
    if (path === '/v1/internal/github/app/webhook')
        return 'secrets-capability';
    if (isTreeDxCredentialBridgePath(path))
        return 'secrets-capability';
    if (path.startsWith('/v1/provider/') || path.startsWith('/v1/provider-registrations'))
        return 'provider-ingress';
    if (path.startsWith('/v1/platform/runners/'))
        return 'platform-runner';
    if (path.startsWith('/v1/platform/operations'))
        return 'platform-operation';
    if (path.startsWith('/v1/ui/'))
        return 'market-ui';
    if (path.startsWith('/v1/auth/'))
        return 'auth';
    if (path.startsWith('/v1/commons/'))
        return 'commons';
    if (path.startsWith('/v1/teams/'))
        return 'team';
    if (path.startsWith('/v1/projects/'))
        return 'project';
    if (path.startsWith('/v1/commerce/'))
        return 'commerce';
    if (path.startsWith('/v1/capacity/') || path.includes('/capacity-'))
        return 'capacity';
    if (path.startsWith('/v1/catalog'))
        return 'catalog';
    if (path.startsWith('/v1/seeds/'))
        return 'seed';
    if (path.startsWith('/v1/acceptance/'))
        return 'acceptance';
    if (path.startsWith('/v1/me') || path.startsWith('/v1/markets/'))
        return 'identity';
    return 'market';
}
