import { matchesCaseFilter, equalJsonValue } from './index.js';

export function getPath(value, path) {
    return String(path).split('.').filter(Boolean).reduce((current, part) => {
        if (current == null)
            return undefined;
        if (/^\d+$/u.test(part))
            return current[Number(part)];
        return current[part];
    }, value);
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
