import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { ACCEPTANCE_ACTORS, API_ROUTE_DESCRIPTORS, SDK_METHOD_ROUTE_MAP } from '../../src/api/route-descriptors.ts';
import { fixtureValue, descriptorPath, bodyForFactory, expectedForDescriptor, expandDescriptorMatrices, sdkArgsForMethod, actorForSdkMethod, expandSdkMethodMatrices, assertCoverage, junit, caseNeedsIsolatedSession, actorForCase, main } from './index.js';

export function parseArgs(argv) {
    const args: Record<string, any> = {
        environment: process.env.TREESEED_ACCEPTANCE_ENVIRONMENT || process.env.TREESEED_ENVIRONMENT || 'local',
        baseUrl: process.env.TREESEED_API_BASE_URL || '',
        spec: 'tests/acceptance/api/base.yaml',
        reportJson: '',
        reportJunit: '',
        expandJson: '',
        caseId: '',
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--environment')
            args.environment = argv[++index];
        else if (arg === '--base-url')
            args.baseUrl = argv[++index];
        else if (arg === '--spec')
            args.spec = argv[++index];
        else if (arg === '--report-json')
            args.reportJson = argv[++index];
        else if (arg === '--report-junit')
            args.reportJunit = argv[++index];
        else if (arg === '--expand-json')
            args.expandJson = argv[++index];
        else if (arg === '--case')
            args.caseId = argv[++index];
        else if (arg === '--help' || arg === '-h')
            args.help = true;
    }
    return args;
}

export function isLoopbackAcceptanceUrl(value) {
    try {
        const url = new URL(value);
        return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(url.hostname);
    }
    catch {
        return false;
    }
}

export function assertAcceptanceTarget(args) {
    const environment = String(args.environment || 'local');
    args.baseUrl = String(args.baseUrl || '').replace(/\/+$/u, '');
    if (!args.baseUrl && environment === 'local') {
        args.baseUrl = 'http://127.0.0.1:3000';
    }
    if (!args.baseUrl) {
        throw new Error(`API acceptance for ${environment} requires --base-url or TREESEED_API_BASE_URL.`);
    }
    if (environment !== 'local' && isLoopbackAcceptanceUrl(args.baseUrl)) {
        throw new Error(`API acceptance for ${environment} must target a live hosted API URL, not ${args.baseUrl}.`);
    }
    if (environment === 'staging' && !/^https:\/\/api\.preview\.treeseed\.dev(?:\/|$)/u.test(args.baseUrl)) {
        throw new Error(`Staging API acceptance must target https://api.preview.treeseed.dev, not ${args.baseUrl}.`);
    }
    if (environment === 'prod' && !/^https:\/\/api\.treeseed\.dev(?:\/|$)/u.test(args.baseUrl)) {
        throw new Error(`Production API acceptance must target https://api.treeseed.dev, not ${args.baseUrl}.`);
    }
}

export function matchesCaseFilter(caseId, candidateId) {
    return !caseId || candidateId === caseId;
}

export function loadExpectedStatuses(path = 'tests/acceptance/api/expected-statuses.json') {
    if (!path || !existsSync(path))
        return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed.statuses ?? {};
}

export function deepMerge(left, right) {
    if (Array.isArray(left) || Array.isArray(right))
        return right ?? left;
    if (!left || typeof left !== 'object')
        return right;
    if (!right || typeof right !== 'object')
        return left;
    const merged = { ...left };
    for (const [key, value] of Object.entries(right)) {
        merged[key] = key in merged ? deepMerge(merged[key], value) : value;
    }
    return merged;
}

export function loadSpec(path, seen = new Set()) {
    const absolute = resolve(path);
    if (seen.has(absolute))
        throw new Error(`Recursive acceptance spec extends: ${absolute}`);
    seen.add(absolute);
    const doc = parse(readFileSync(absolute, 'utf8')) ?? {};
    const parentSpecs = Array.isArray(doc.extends) ? doc.extends : doc.extends ? [doc.extends] : [];
    const base = parentSpecs
        .map((entry) => loadSpec(resolve(dirname(absolute), entry), seen))
        .reduce((acc, entry) => deepMerge(acc, entry), {});
    delete doc.extends;
    return deepMerge(base, doc);
}

export function interpolate(value, variables) {
    if (typeof value === 'string') {
        return value.replace(/\$\{([^}]+)\}/gu, (_, key) => {
            const parts = String(key).split('.');
            let current = variables;
            for (const part of parts)
                current = current?.[part];
            return current == null ? '' : String(current);
        });
    }
    if (Array.isArray(value))
        return value.map((entry) => interpolate(entry, variables));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, interpolate(entry, variables)]));
    }
    return value;
}

export function equalJsonValue(left, right) {
    if (Object.is(left, right))
        return true;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
        return false;
    return JSON.stringify(left) === JSON.stringify(right);
}

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

export function acceptanceRequestTimeoutMs() {
    const value = Number.parseInt(process.env.TREESEED_ACCEPTANCE_REQUEST_TIMEOUT_MS ?? '30000', 10);
    return Number.isFinite(value) && value > 0 ? value : 30000;
}

export function acceptanceRequestAttempts() {
    const value = Number.parseInt(process.env.TREESEED_ACCEPTANCE_REQUEST_ATTEMPTS ?? '5', 10);
    return Number.isFinite(value) && value > 0 ? value : 5;
}

export function retryDelayMs(attempt) {
    return Math.min(250 * (2 ** Math.max(0, attempt - 1)), 3000);
}

export function isRetryableFetchError(error) {
    const code = error?.cause?.code ?? error?.code;
    return [
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_SOCKET',
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'EAI_AGAIN',
    ].includes(code);
}

export function isRetryableResponse(response) {
    return [408, 425, 429, 500, 502, 503, 504].includes(response.status);
}

export function sanitizeDiagnosticValue(value) {
    if (typeof value === 'string') {
        return value.replace(/([A-Za-z0-9_-]*(?:secret|token|password|credential|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)[^"',\s}]+/giu, '$1[redacted]');
    }
    if (Array.isArray(value))
        return value.map((entry) => sanitizeDiagnosticValue(entry));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
            key,
            /(?:secret|token|password|credential|api[_-]?key|private[_-]?key|ciphertext)/iu.test(key)
                ? '[redacted]'
                : sanitizeDiagnosticValue(entry),
        ]));
    }
    return value;
}

export async function fetchWithTimeout(url, init: any = {}, label = String(url)) {
    const timeoutMs = acceptanceRequestTimeoutMs();
    const maxAttempts = init.signal ? 1 : acceptanceRequestAttempts();
    let lastError = null;
    let lastResponse = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error(`Acceptance request timed out after ${timeoutMs}ms: ${label}`)), timeoutMs);
        try {
            const response = await fetch(url, {
                ...init,
                signal: init.signal ?? controller.signal,
            });
            if (!isRetryableResponse(response) || attempt >= maxAttempts)
                return response;
            lastResponse = response;
            lastError = null;
        }
        catch (error) {
            lastResponse = null;
            if (controller.signal.aborted) {
                lastError = new Error(`Acceptance request timed out after ${timeoutMs}ms: ${label}`);
            }
            else {
                lastError = error;
            }
            const retryable = controller.signal.aborted || isRetryableFetchError(error);
            if (!retryable || attempt >= maxAttempts)
                break;
        }
        finally {
            clearTimeout(timeout);
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
    if (lastResponse) {
        throw new Error(`Acceptance request failed for ${label}: retryable HTTP ${lastResponse.status} after ${maxAttempts} attempts.`);
    }
    const cause = lastError?.cause;
    const details = cause?.code || cause?.message
        ? ` (${[cause?.code, cause?.message].filter(Boolean).join(': ')})`
        : '';
    throw new Error(`Acceptance request failed for ${label}: ${lastError?.message ?? String(lastError)}${details}`);
}

export function getPath(value, path) {
    return String(path).split('.').filter(Boolean).reduce((current, part) => {
        if (current == null)
            return undefined;
        if (/^\d+$/u.test(part))
            return current[Number(part)];
        return current[part];
    }, value);
}

export function mailpitMessages(value) {
    if (!value || typeof value !== 'object')
        return [];
    const record = value;
    const messages = record.messages ?? record.Messages;
    return Array.isArray(messages) ? messages : [];
}

export function mailpitMessageSubject(value) {
    if (!value || typeof value !== 'object')
        return '';
    const record = value;
    return String(record.Subject ?? record.subject ?? '');
}

export function mailpitMessageRecipients(value) {
    if (!value || typeof value !== 'object')
        return [];
    const record = value;
    const recipients = record.To ?? record.to ?? record.Recipients ?? record.recipients;
    if (!Array.isArray(recipients))
        return [];
    return recipients.map((recipient) => {
        if (typeof recipient === 'string')
            return recipient;
        if (!recipient || typeof recipient !== 'object')
            return '';
        const entry = recipient;
        return String(entry.Address ?? entry.address ?? entry.Email ?? entry.email ?? '');
    }).filter(Boolean);
}

export async function assertMailpitExpectation(expectation, environment = 'local') {
    if (!expectation)
        return [];
    if (environment !== 'local')
        return [];
    const url = String(expectation.url ?? process.env.TREESEED_MAILPIT_URL ?? 'http://127.0.0.1:8025').replace(/\/+$/u, '');
    const to = String(expectation.to ?? '').toLowerCase();
    const subjectIncludes = expectation.subjectIncludes ? String(expectation.subjectIncludes).toLowerCase() : '';
    const timeoutMs = Number(expectation.timeoutMs ?? 5000);
    const started = Date.now();
    let lastError = '';
    while (Date.now() - started <= timeoutMs) {
        try {
            const response = await fetchWithTimeout(`${url}/api/v1/messages`, {}, 'GET Mailpit messages');
            if (!response.ok) {
                lastError = `Mailpit returned HTTP ${response.status}`;
            }
            else {
                const list = await response.json();
                const found = mailpitMessages(list).some((message) => {
                    const recipients = mailpitMessageRecipients(message).map((entry) => entry.toLowerCase());
                    const subject = mailpitMessageSubject(message).toLowerCase();
                    return (!to || recipients.includes(to)) && (!subjectIncludes || subject.includes(subjectIncludes));
                });
                if (found)
                    return [];
                lastError = `No Mailpit message found${to ? ` for ${to}` : ''}.`;
            }
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return [`Mailpit expectation failed: ${lastError}`];
}

export function assertCase(caseSpec, response, body) {
    const failures = [];
    const expectedStatus = Number(caseSpec.expect?.status ?? caseSpec.expect?.statusAny?.[0] ?? 200);
    const expectedStatuses = Array.isArray(caseSpec.expect?.statusAny)
        ? caseSpec.expect.statusAny.map((entry) => Number(entry))
        : [expectedStatus];
    if (!expectedStatuses.includes(response.status)) {
        failures.push(`expected status ${expectedStatus}, got ${response.status}`);
    }
    if (caseSpec.expect?.envelope) {
        const envelope = caseSpec.expect.envelope;
        if (envelope.ok !== undefined && body?.ok !== envelope.ok)
            failures.push(`expected envelope ok=${envelope.ok}, got ${body?.ok}`);
    }
    for (const assertion of caseSpec.expect?.json ?? []) {
        const actual = getPath(body, assertion.path);
        if ('equals' in assertion && !equalJsonValue(actual, assertion.equals))
            failures.push(`${assertion.path} expected ${JSON.stringify(assertion.equals)}, got ${JSON.stringify(actual)}`);
        if ('exists' in assertion && Boolean(actual !== undefined && actual !== null) !== Boolean(assertion.exists))
            failures.push(`${assertion.path} existence mismatch`);
        if ('type' in assertion && typeof actual !== assertion.type)
            failures.push(`${assertion.path} expected type ${assertion.type}, got ${typeof actual}`);
    }
    return failures;
}

export function expandRoleMatrices(spec, caseId = '') {
    const matrices = Array.isArray(spec.roleMatrices) ? spec.roleMatrices : [];
    const expanded = [];
    for (const matrix of matrices) {
        const actors = Array.isArray(matrix.actors) ? matrix.actors : [];
        const endpoints = Array.isArray(matrix.endpoints) ? matrix.endpoints : [];
        for (const endpoint of endpoints) {
            for (const actor of actors) {
                const id = `${matrix.id}.${endpoint.id}.${actor}`;
                if (!matchesCaseFilter(caseId, id))
                    continue;
                const actorOverride = endpoint.expectByActor?.[actor] ?? {};
                const expected = {
                    ...(matrix.expect ?? {}),
                    ...(endpoint.expect ?? {}),
                    ...actorOverride,
                };
                expanded.push({
                    id,
                    actor,
                    method: endpoint.method ?? 'GET',
                    path: endpoint.path,
                    body: endpoint.body,
                    expect: {
                        status: expected.status ?? 200,
                        envelope: expected.envelope ?? { ok: Number(expected.status ?? 200) < 400 },
                        json: expected.json,
                    },
                    environments: endpoint.environments ?? matrix.environments,
                });
            }
        }
    }
    return expanded;
}
