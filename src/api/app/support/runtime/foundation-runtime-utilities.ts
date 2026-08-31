import { getSiteAuthConfig } from '../../../../auth/config.ts';
import { backfillUserEmailAddresses,normalizeBaseUrl,parseBooleanEnvValue,redactedRequestTarget } from '../index.ts';
export async function accountDeletionBlockers(store, principal) {
    const teams = await store.listTeamsForPrincipal(principal);
    const blockers = teams
        .filter((team) => {
        const ownsTeam = Array.isArray(team.roles)
            ? team.roles.some((role) => role === 'owner' || role === 'team_owner')
            : team.role === 'owner' || team.role === 'team_owner';
        return ownsTeam && team.metadata?.kind !== 'personal_research';
    })
        .map((team) => ({
        code: 'team_owner',
        message: `Transfer or delete team "${team.displayName ?? team.name ?? team.slug}" before deleting this account.`,
        teamId: team.id,
        teamSlug: team.slug,
        teamName: team.displayName ?? team.name ?? team.slug,
    }));
    if (principal.roles?.includes?.('platform_admin'))
        blockers.push({ code: 'platform_admin', message: 'Remove platform admin role before deleting this account.' });
    return blockers;
}
export function base64Url(value) {
    return Buffer.from(value).toString('base64url');
}
export function shouldLogApiRequests(config, options: any = {}) {
    if (typeof options.logRequests === 'boolean')
        return options.logRequests;
    const explicit = parseBooleanEnvValue(process.env.TREESEED_API_REQUEST_LOGS);
    if (explicit != null)
        return explicit;
    if (process.env.NODE_ENV === 'test')
        return false;
    const environment = String(config?.environment ?? process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? '').trim();
    return environment === 'local';
}
export const SENSITIVE_QUERY_PARAM_PATTERN = /(?:token|secret|password|credential|assertion|signature|api[_-]?key|access[_-]?key|private[_-]?key|code)/iu;
export function installApiRequestLogger(app) {
    app.use('*', async (c, next) => {
        const startedAt = Date.now();
        const method = c.req.method;
        const target = redactedRequestTarget(c.req.url);
        try {
            await next();
        }
        finally {
            const elapsedMs = Date.now() - startedAt;
            const status = c.res?.status ?? 500;
            process.stdout.write(`[api] ${method} ${target} -> ${status} ${elapsedMs}ms\n`);
        }
    });
}
export async function readJsonOrFormBody(c) {
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('application/json')) {
        const json = await c.req.json().catch(() => null);
        if (json && typeof json === 'object' && !Array.isArray(json)) {
            return json;
        }
    }
    const form = await c.req.parseBody?.().catch(() => ({}));
    if (!form || typeof form !== 'object') {
        return {};
    }
    return Object.fromEntries(Object.entries(form).map(([key, value]) => [key, typeof value === 'string' ? value : String(value ?? '')]));
}
export function trimmedHeaderValue(c, name) {
    const value = c.req.header(name);
    return typeof value === 'string' ? value.trim() : '';
}
export function requestClientIp(c) {
    const forwardedFor = trimmedHeaderValue(c, 'x-forwarded-for')
        .split(',')
        .map((part) => part.trim())
        .find(Boolean);
    return (trimmedHeaderValue(c, 'cf-connecting-ip')
        || trimmedHeaderValue(c, 'true-client-ip')
        || trimmedHeaderValue(c, 'x-real-ip')
        || trimmedHeaderValue(c, 'x-treeseed-client-ip')
        || forwardedFor
        || null);
}
export async function ensureControlPlaneCredentialSchema(store) {
    await store.ensureInitialized();
    await backfillUserEmailAddresses(store);
}
export function sanitizedReturnTo(value) {
    const target = String(value ?? '/app/');
    return target.startsWith('/') && !target.startsWith('//') ? target : '/app/';
}
export function confirmationUrlFor(context, token, returnTo) {
    const authConfig = getSiteAuthConfig(context);
    const target = new URL('/auth/confirm-email', `${authConfig.siteBaseUrl.replace(/\/+$/u, '')}/`);
    target.searchParams.set('token', token);
    target.searchParams.set('returnTo', sanitizedReturnTo(returnTo));
    return target.toString();
}
export function teamInviteAcceptUrlFor(context, token) {
    const authConfig = getSiteAuthConfig(context);
    return new URL(`/team-invites/${encodeURIComponent(token)}/accept`, `${authConfig.siteBaseUrl.replace(/\/+$/u, '')}/`).toString();
}
export function optionalTrimmedString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
export function enumValue(value, allowed, fallback = null) {
    const candidate = typeof value === 'string' ? value.trim() : '';
    return allowed.includes(candidate) ? candidate : fallback;
}
export function unknownKeys(body, allowed) {
    const allow = new Set(allowed);
    return Object.keys(body && typeof body === 'object' && !Array.isArray(body) ? body : {})
        .filter((key) => !allow.has(key));
}
export function yamlScalar(value) {
    const text = String(value ?? '');
    if (/^[a-zA-Z0-9_:/.-]+$/u.test(text) && !['true', 'false', 'null'].includes(text.toLowerCase())) {
        return text;
    }
    return JSON.stringify(text);
}
export function yamlLines(value, indent = 0) {
    const pad = ' '.repeat(indent);
    if (Array.isArray(value)) {
        if (value.length === 0)
            return [`${pad}[]`];
        return value.flatMap((entry) => {
            if (entry && typeof entry === 'object') {
                return [``, ...yamlLines(entry, indent + 2)].map((line, index) => index === 0 ? `${pad}-` : line);
            }
            return [`${pad}- ${yamlScalar(entry)}`];
        });
    }
    if (value && typeof value === 'object') {
        return Object.entries(value).flatMap(([key, entry]) => {
            if (Array.isArray(entry) || (entry && typeof entry === 'object')) {
                return [`${pad}${key}:`, ...yamlLines(entry, indent + 2)];
            }
            return [`${pad}${key}: ${yamlScalar(entry)}`];
        });
    }
    return [`${pad}${yamlScalar(value)}`];
}
export function isLoopbackUrl(value) {
    try {
        const url = new URL(value);
        return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    }
    catch {
        return false;
    }
}
export function findById(items, id) {
    const key = String(id ?? '');
    return Array.isArray(items)
        ? items.find((item) => String(item?.id ?? item?.taskId ?? item?.workDayId ?? item?.work_day_id ?? '') === key)
        : null;
}
export function resolveAgentArtifactBucket(runtime) {
    const env = runtime?.env && typeof runtime.env === 'object' ? runtime.env : {};
    const binding = String(env.TREESEED_AGENT_ARTIFACT_BUCKET_BINDING
        ?? env.CONTENT_BUCKET_BINDING
        ?? 'TREESEED_CONTENT_BUCKET').trim();
    const candidates = [
        env.TREESEED_AGENT_ARTIFACT_BUCKET,
        binding ? env[binding] : null,
        env.TREESEED_CONTENT_BUCKET,
    ];
    return candidates.find((candidate) => candidate && typeof candidate === 'object' && typeof candidate.put === 'function') ?? null;
}
export function scheduleBackgroundBootstrap(c, task) {
    const promise = Promise.resolve()
        .then(task)
        .catch((error) => {
        process.stderr.write(`[api] project launch bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    });
    let executionCtx = null;
    try {
        executionCtx = c.executionCtx;
    }
    catch {
        executionCtx = null;
    }
    if (typeof executionCtx?.waitUntil === 'function') {
        executionCtx.waitUntil(promise);
    }
    return promise;
}
export function base64urlJson(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
export function canonicalArchitectureTopology(value) {
    if (value === 'combined_compatibility')
        return 'single_repository_site';
    if (value === 'split_software_content')
        return 'split_site_content';
    if (['single_repository_site', 'split_site_content', 'parent_workspace'].includes(value))
        return value;
    return 'split_site_content';
}
export function decodeRouteParam(value) {
    let decoded = String(value ?? '');
    for (let index = 0; index < 2; index += 1) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded)
                break;
            decoded = next;
        }
        catch {
            break;
        }
    }
    return decoded;
}
export function uiRuntimeLocals(config) {
    return {
        runtime: {
            resolved: {
                config: {
                    repoRoot: config?.repoRoot ?? process.cwd(),
                },
            },
            env: {
                TREESEED_ENVIRONMENT: config?.environment ?? process.env.TREESEED_ENVIRONMENT ?? 'prod',
            },
        },
    };
}
export const AGENT_TASK_SIGNATURES = {
    'question.summarize': {
        defaultSeconds: 300,
        requiredCapabilities: ['treeseed.coordination.question-answering'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: true,
        priorityClass: 'background',
    },
    'proposal.draft': {
        defaultSeconds: 600,
        requiredCapabilities: ['treeseed.publishing.drafting'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: true,
        priorityClass: 'interactive',
    },
    'proposal.compare': {
        defaultSeconds: 600,
        requiredCapabilities: ['treeseed.coordination.review'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: true,
        priorityClass: 'background',
    },
    'decision.summary': {
        defaultSeconds: 480,
        requiredCapabilities: ['treeseed.coordination.reporting'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: true,
        priorityClass: 'background',
    },
    'release.summary': {
        defaultSeconds: 480,
        requiredCapabilities: ['treeseed.publishing.release-notes'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: true,
        priorityClass: 'background',
    },
    'repository.change.apply': {
        defaultSeconds: 1200,
        requiredCapabilities: ['treeseed.engineering.code-change'],
        repositoryMutation: true,
        bindingWork: true,
        productionAllowed: false,
        priorityClass: 'interactive',
    },
    'verification.run': {
        defaultSeconds: 900,
        requiredCapabilities: ['treeseed.engineering.integration-testing'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: false,
        priorityClass: 'background',
    },
    'workday.report': {
        defaultSeconds: 300,
        requiredCapabilities: ['treeseed.coordination.reporting'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: true,
        priorityClass: 'background',
    },
};
export function createApiExtension(options: any = {}) {
    return {
        name: options.name ?? 'treeseed-api',
        mount: options.mount ?? ((app, runtime) => options.extendApp?.(app, runtime)),
    };
}
