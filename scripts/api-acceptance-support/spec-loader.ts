import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';

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
