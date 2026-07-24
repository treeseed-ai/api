import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expandDescriptorMatrices, expandSdkMethodMatrices, assertCoverage, junit, actorForCase, record, type AcceptanceActor, parseArgs, assertAcceptanceTarget, matchesCaseFilter, loadExpectedStatuses, loadSpec, interpolate, actorHeaders, loadMarketClient, serviceHeaders, addOptionalAcceptanceServiceHeaders, usesHostedAcceptanceEmailBypass, sanitizeDiagnosticValue, fetchWithTimeout, assertMailpitExpectation, assertCase, expandRoleMatrices } from './index.js';

export async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('Usage: npm run test:acceptance -- --environment staging|prod --base-url https://api.example.com [--spec path] [--report-json path] [--report-junit path] [--expand-json path]');
        process.exit(0);
    }
    assertAcceptanceTarget(args);
    const spec = loadSpec(args.spec);
    const expectedStatuses = loadExpectedStatuses(spec.expectedStatuses);
    const variables = {
        environment: args.environment,
        baseUrl: args.baseUrl,
        runNonce: [
            Date.now().toString(36),
            randomBytes(4).toString('hex'),
        ].filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9-]+/gu, '-'),
        ...(spec.variables ?? {}),
    };
    const actors: Record<string, AcceptanceActor> = Object.fromEntries(Object.entries(spec.actors ?? {}).map(([id, actor]) => [id, { id, ...record(actor) }]));
    if (spec.seed?.enabled !== false && !args.expandJson) {
        const seedBody = interpolate({
            namespace: spec.seed?.namespace ?? `acceptance-${args.environment}`,
            password: spec.seed?.password ?? undefined,
            actors: spec.seed?.actors ?? undefined,
        }, variables);
        const seedPath = spec.seed?.path ?? '/v1/acceptance/seed';
        const seedResponse = await fetchWithTimeout(`${variables.baseUrl}${seedPath}`, {
            method: 'POST',
            headers: serviceHeaders(spec),
            body: JSON.stringify(seedBody),
        }, `POST ${seedPath}`);
        const seedEnvelope = await seedResponse.json().catch(() => null);
        if (!seedResponse.ok || seedEnvelope?.ok === false) {
            const details = seedEnvelope == null
                ? 'no JSON response body'
                : JSON.stringify(sanitizeDiagnosticValue(seedEnvelope));
            throw new Error(seedEnvelope?.error
                ? `Acceptance seed failed with status ${seedResponse.status}: ${seedEnvelope.error}; body=${details}`
                : `Acceptance seed failed with status ${seedResponse.status}; body=${details}`);
        }
        variables.fixtures = seedEnvelope.payload?.fixtures ?? {};
        variables.seed = {
            namespace: seedEnvelope.payload?.namespace,
            password: seedEnvelope.payload?.password,
        };
        for (const [id, actor] of Object.entries(seedEnvelope.payload?.actors ?? {})) {
            const actorRecord = record(actor);
            actors[id] = {
                ...(actors[id] ?? { id }),
                id,
                token: typeof actorRecord.accessToken === 'string' ? actorRecord.accessToken : undefined,
                email: typeof actorRecord.email === 'string' ? actorRecord.email : undefined,
                username: typeof actorRecord.username === 'string' ? actorRecord.username : undefined,
            };
        }
        variables.actors = Object.fromEntries(Object.entries(actors).map(([id, actor]) => [id, {
                email: actor.email,
                emailEncoded: actor.email ? encodeURIComponent(actor.email) : '',
                username: actor.username,
            }]));
    }
    const explicitCases = Array.isArray(spec.cases) ? spec.cases.filter((entry) => matchesCaseFilter(args.caseId, entry.id)) : [];
    const allCases = [
        ...explicitCases,
        ...expandRoleMatrices(spec, args.caseId),
        ...expandDescriptorMatrices(spec, expectedStatuses, args.caseId),
        ...expandSdkMethodMatrices(spec, expectedStatuses, args.caseId),
    ];
    if (!args.caseId)
        assertCoverage(spec, allCases);
    const cases = allCases
        .filter((entry) => !entry.environments || entry.environments.includes(args.environment))
        .filter((entry) => matchesCaseFilter(args.caseId, entry.id));
    if (args.caseId && cases.length === 0) {
        const message = `Acceptance case not found for environment ${args.environment}: ${args.caseId}`;
        if (args.reportJson) {
            mkdirSync(dirname(args.reportJson), { recursive: true });
            writeFileSync(args.reportJson, `${JSON.stringify({ ok: false, environment: args.environment, caseId: args.caseId, error: message, results: [] }, null, 2)}\n`);
        }
        console.error(message);
        process.exit(1);
    }
    if (args.expandJson) {
        mkdirSync(dirname(args.expandJson), { recursive: true });
        writeFileSync(args.expandJson, `${JSON.stringify({
            ok: true,
            environment: args.environment,
            caseCount: cases.length,
            cases: cases.map((entry) => ({
                id: entry.id,
                descriptorId: entry.descriptorId ?? null,
                actor: entry.actor ?? 'anonymous',
                method: entry.method ?? 'GET',
                path: entry.path ?? null,
                sdkMethod: entry.sdkMethod ?? null,
                expect: entry.expect ?? {},
            })),
        }, null, 2)}\n`);
        console.log(`expanded ${cases.length} acceptance cases to ${args.expandJson}`);
        return;
    }
    const results = [];
    for (const rawCase of cases) {
        const caseSpec = interpolate(rawCase, variables);
        const started = Date.now();
        let response;
        let body = null;
        let failures = [];
        try {
            if (caseSpec.coverageOnly) {
                results.push({
                    id: caseSpec.id,
                    actor: caseSpec.actor ?? 'anonymous',
                    method: caseSpec.method ?? 'GET',
                    path: caseSpec.path,
                    status: null,
                    ok: true,
                    skipped: true,
                    coverageOnly: true,
                    failures: [],
                    durationMs: Date.now() - started,
                });
                console.log(`coverage ${caseSpec.id}`);
                continue;
            }
            {
                const actor = await actorForCase(caseSpec, actors[caseSpec.actor ?? 'anonymous'] ?? {}, variables);
                const headers = actorHeaders(actor);
                if (!headers) {
                    results.push({
                        id: caseSpec.id,
                        actor: caseSpec.actor ?? 'anonymous',
                        method: caseSpec.method ?? 'GET',
                        path: caseSpec.path,
                        status: null,
                        ok: true,
                        skipped: true,
                        failures: [],
                        durationMs: Date.now() - started,
                    });
                    console.log(`skip ${caseSpec.id} missing optional actor credential`);
                    continue;
                }
                headers.set('accept', 'application/json');
                const emailBypass = usesHostedAcceptanceEmailBypass(caseSpec, args.environment);
                addOptionalAcceptanceServiceHeaders(headers, { environment: args.environment, enabled: emailBypass });
                if (caseSpec.body !== undefined)
                    headers.set('content-type', 'application/json');
                if (caseSpec.sdkMethod) {
                    const { MarketClient } = await loadMarketClient();
                    let sdkResponseStatus = null;
                    const sdkFetch = async (url, init: any = {}) => {
                        const sdkHeaders = new Headers(init.headers ?? {});
                        addOptionalAcceptanceServiceHeaders(sdkHeaders, { environment: args.environment, enabled: emailBypass });
                        const sdkResponse = await fetchWithTimeout(url, { ...init, headers: sdkHeaders }, `${caseSpec.sdkMethod} ${url}`);
                        sdkResponseStatus = sdkResponse.status;
                        return sdkResponse;
                    };
                    const client = new MarketClient({
                        profile: {
                            id: args.environment,
                            label: args.environment,
                            baseUrl: variables.baseUrl,
                            kind: 'specialized',
                        },
                        accessToken: actor.token ?? null,
                        fetchImpl: sdkFetch,
                        userAgent: 'treeseed-acceptance/1',
                    });
                    try {
                        body = await client[caseSpec.sdkMethod](...(caseSpec.sdkArgs ?? []));
                        response = { status: sdkResponseStatus ?? 0 };
                    }
                    catch (error) {
                        if (typeof error?.status === 'number') {
                            body = error.payload ?? { ok: false, error: error.message };
                            response = { status: error.status };
                        }
                        else {
                            throw error;
                        }
                    }
                }
                else {
                    response = await fetchWithTimeout(`${variables.baseUrl}${caseSpec.path}`, {
                        method: caseSpec.method ?? 'GET',
                        headers,
                        body: caseSpec.body === undefined ? undefined : JSON.stringify(caseSpec.body),
                    }, `${caseSpec.method ?? 'GET'} ${caseSpec.path}`);
                    body = await response.json().catch(() => null);
                }
                failures = assertCase(caseSpec, response, body);
                failures.push(...await assertMailpitExpectation(caseSpec.expect?.mailpit, args.environment));
            }
        }
        catch (error) {
            failures = [error?.message ?? String(error)];
        }
        const result = {
            id: caseSpec.id,
            actor: caseSpec.actor ?? 'anonymous',
            method: caseSpec.method ?? 'GET',
            path: caseSpec.path,
            status: response?.status ?? null,
            ok: failures.length === 0,
            failures,
            durationMs: Date.now() - started,
        };
        results.push(result);
        console.log(`${result.ok ? 'ok' : 'not ok'} ${result.id} ${result.method} ${result.path}`);
        if (!result.ok)
            console.log(`  ${failures.join('\n  ')}`);
    }
    const report = {
        ok: results.every((result) => result.ok),
        environment: args.environment,
        baseUrl: variables.baseUrl,
        results,
    };
    if (args.reportJson) {
        mkdirSync(dirname(args.reportJson), { recursive: true });
        writeFileSync(args.reportJson, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (args.reportJunit) {
        mkdirSync(dirname(args.reportJunit), { recursive: true });
        writeFileSync(args.reportJunit, `${junit(report)}\n`);
    }
    if (!report.ok)
        process.exit(1);
    if (!existsSync(args.spec))
        process.exit(1);
}
