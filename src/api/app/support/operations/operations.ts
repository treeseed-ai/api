import { derivePlatformOperationNavigation,isPlatformOperationTerminal } from '@treeseed/sdk';
import { createHmac,timingSafeEqual } from 'node:crypto';
import { bearerTokenFromRequest } from '../../../accounts/request-auth.ts';
import { base64urlJson,jsonError,normalizeBaseUrl,optionalTrimmedString,parseBase64urlJson,requireTeamAccess,safeTokenEquals } from '../index.ts';
export const AGENT_PROMOTION_APPROVAL_DECISIONS = new Set([
    'approve',
    'approve_as_book_content',
    'request_changes',
    'request_more_research',
    'defer',
    'reject',
    'approve_release',
    'reject_release',
]);
export const PLATFORM_OPERATION_SCOPES = [
    'platform:runners:register',
    'platform:runners:claim',
    'platform:runners:update',
    'platform:operations:create',
    'platform:operations:read',
    'platform:operations:cancel',
    'platform:operations:retry',
    'platform:deploy:write',
    'platform:database:migrate',
];
export function operationTokenSecret(runtime) {
    return runtime?.resolved?.config?.assertionSecret
        ?? runtime?.resolved?.config?.authSecret
        ?? process.env.TREESEED_AUTH_SECRET
        ?? 'treeseed-local-operation-token-secret';
}
export function signOperationToken(runtime, payload) {
    const body = base64urlJson(payload);
    const signature = createHmac('sha256', operationTokenSecret(runtime)).update(body).digest('base64url');
    return `${body}.${signature}`;
}
export function verifyOperationToken(runtime, token) {
    const [body, signature] = String(token ?? '').split('.');
    if (!body || !signature) {
        throw new Error('Invalid operation token.');
    }
    const expected = createHmac('sha256', operationTokenSecret(runtime)).update(body).digest('base64url');
    const providedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
        throw new Error('Invalid operation token signature.');
    }
    const payload = parseBase64urlJson(body);
    if (!payload.exp || Number(payload.exp) <= Math.floor(Date.now() / 1000)) {
        throw new Error('Operation token expired.');
    }
    return payload;
}
export function normalizeCiEnvironment(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'prod' || normalized === 'production' ? 'prod' : 'staging';
}
export function ciOperationForAction(actionKind) {
    switch (String(actionKind ?? 'deploy_web')) {
        case 'publish_content':
            return { namespace: 'content', operation: 'publish' };
        case 'monitor':
            return { namespace: 'workflow', operation: 'verify_runtime' };
        case 'deploy_web':
        default:
            return { namespace: 'workflow', operation: 'deploy_runtime' };
    }
}
export function validateCiRefForEnvironment(environment, claims) {
    const ref = String(claims.ref ?? '');
    if (environment === 'prod') {
        return ref === 'refs/heads/main' || ref.startsWith('refs/tags/');
    }
    return ref === 'refs/heads/staging';
}
export function principalHasPermission(principal, permission) {
    return Boolean(principal
        && (principal.permissions?.includes?.('*:*:*')
            || principal.permissions?.includes?.(permission)));
}
export function principalIsSeedAdmin(principal) {
    return Boolean(principal
        && (principal.permissions?.includes?.('*:*:*')
            || principal.permissions?.includes?.('seeds:apply:global')
            || principal.roles?.includes?.('platform_admin')
            || principal.roles?.includes?.('platform_admin')));
}
export function isTeamApiPrincipal(principal) {
    return Boolean(principal?.roles?.includes?.('team_api_key'));
}
export function isLocalAcceptanceServicePrincipal(c, principal) {
    return c.get('actorType') === 'service'
        && principal?.metadata?.localAcceptance === true
        && principalHasPermission(principal, '*:*:*');
}
export function decorateJob(baseUrl, job) {
    if (!job)
        return null;
    return {
        ...job,
        pollUrl: `${baseUrl}/v1/jobs/${job.id}`,
        streamUrl: `${baseUrl}/v1/jobs/${job.id}/events`,
    };
}
export function safePlatformOperationOutput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return value ?? null;
    const output = { ...value };
    if (typeof output.workspacePath === 'string') {
        output.workspacePath = output.workspacePath.includes('/data') ? '/data' : '<runner-workspace>';
    }
    return output;
}
export function decoratePlatformOperation(baseUrl, operation) {
    if (!operation)
        return null;
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl ?? '');
    const navigation = derivePlatformOperationNavigation(operation);
    const safeOutput = safePlatformOperationOutput(operation.output);
    return {
        ...operation,
        output: safeOutput,
        pollUrl: `${normalizedBaseUrl}/v1/platform/operations/${operation.id}`,
        streamUrl: `${normalizedBaseUrl}/v1/platform/operations/${operation.id}/events`,
        terminal: isPlatformOperationTerminal(operation),
        navigation,
        href: navigation.href,
        changedPaths: navigation.changedPaths,
        branch: navigation.branch,
        commitSha: navigation.commitSha,
    };
}
export function resolvePlatformRunnerSecret(config) {
    return optionalTrimmedString(config.platformRunnerSecret)
        ?? optionalTrimmedString(config.operationsRunnerSecret)
        ?? optionalTrimmedString(process.env.TREESEED_PLATFORM_RUNNER_SECRET)
        ?? optionalTrimmedString(process.env.TREESEED_PLATFORM_RUNNER_SECRET);
}
export function platformOperationMutationError(c, error) {
    const status = Number(error?.status ?? 500);
    if (![400, 404, 409].includes(status))
        throw error;
    return jsonError(c, status, error instanceof Error ? error.message : String(error), error?.details ?? {});
}
export async function requirePlatformRunner(c, config) {
    const token = bearerTokenFromRequest(c.req.raw);
    const secret = resolvePlatformRunnerSecret(config);
    if (!token || !secret) {
        return {
            response: jsonError(c, 401, 'Platform runner service credential required.'),
        };
    }
    if (!safeTokenEquals(token, secret)) {
        return {
            response: jsonError(c, 401, 'Invalid platform runner service credential.'),
        };
    }
    return {
        principal: {
            id: 'platform-runner',
            roles: ['platform_runner'],
            permissions: [...PLATFORM_OPERATION_SCOPES],
            scopes: [...PLATFORM_OPERATION_SCOPES],
        },
    };
}
export async function ensurePrincipal(c) {
    const principal = c.get('principal');
    if (!principal) {
        return {
            response: jsonError(c, 401, 'Authentication required.'),
        };
    }
    return { principal };
}
export function principalHasGlobalPlatformRole(principal) {
    return Boolean(principal?.roles?.includes?.('platform_admin')
        || principal?.roles?.includes?.('platform_admin')
        || principal?.permissions?.includes?.('*:*:*'));
}
export async function requireServiceParticipantAccess(c, store, request, sellerPermission = 'projects:read:team') {
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    if (principalIsSeedAdmin(auth.principal))
        return auth;
    if (request?.sellerTeamId) {
        const seller = await requireTeamAccess(c, store, request.sellerTeamId, sellerPermission);
        if (!seller.response)
            return seller;
    }
    if (request?.buyerTeamId) {
        const buyer = await requireTeamAccess(c, store, request.buyerTeamId, 'projects:read:team');
        if (!buyer.response)
            return buyer;
    }
    if (request?.buyerUserId && request.buyerUserId === auth.principal.id)
        return auth;
    return { response: jsonError(c, 403, 'Permission denied.', { requestId: request?.id ?? null }) };
}
export function unwrapOperationPayload(output) {
    if (!output || typeof output !== 'object')
        return null;
    if (output.payload && typeof output.payload === 'object')
        return output.payload;
    return output;
}
