import { isTreeDxCredentialBridgePath } from './index.js';

export function safeProduction(path, method) {
    if (method === 'get')
        return true;
    if (path.startsWith('/v1/auth/web/appearance') || path.startsWith('/v1/auth/web/sessions'))
        return true;
    if (path.startsWith('/v1/acceptance/'))
        return true;
    return false;
}

export function productionSafeStrategy(path, method) {
    if (method === 'get')
        return 'read';
    if (path === '/v1/internal/github/app/webhook')
        return 'signature-authenticated-callback';
    if (isTreeDxCredentialBridgePath(path))
        return 'service-credential-callback';
    if (path.startsWith('/v1/auth/web/appearance') || path.startsWith('/v1/auth/logout') || path.startsWith('/v1/auth/web/sessions/'))
        return 'acceptance-owned';
    if (path.startsWith('/v1/platform/runners/') || path.startsWith('/v1/provider/'))
        return 'acceptance-owned';
    if (path.startsWith('/v1/acceptance/'))
        return 'acceptance-service';
    return 'acceptance-owned-fixture';
}
