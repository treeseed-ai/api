

export function isoNow() {
    return new Date().toISOString();
}

export function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

export function stripSeedRuntimeMetadata(metadata) {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    const seed = source.seed && typeof source.seed === 'object' ? source.seed : null;
    return {
        ...source,
        ...(seed
            ? {
                seed: {
                    name: seed.name,
                    resourceKey: seed.resourceKey,
                    version: seed.version,
                },
            }
            : {}),
    };
}

export function comparablePayload(payload) {
    const next = { ...(payload ?? {}) };
    if (next.metadata && typeof next.metadata === 'object') {
        next.metadata = stripSeedRuntimeMetadata(next.metadata);
    }
    return next;
}

export function actionIsUnchanged(action, currentPayload) {
    return stableJson(comparablePayload(action.payload)) === stableJson(comparablePayload(currentPayload));
}

export function mergeSeedMetadata(existingMetadata, desiredMetadata, action, manifestHash, appliedAt) {
    const desiredSeed = desiredMetadata?.seed && typeof desiredMetadata.seed === 'object' ? desiredMetadata.seed : {};
    return {
        ...(existingMetadata && typeof existingMetadata === 'object' ? existingMetadata : {}),
        ...(desiredMetadata && typeof desiredMetadata === 'object' ? desiredMetadata : {}),
        seed: {
            ...desiredSeed,
            name: desiredSeed.name ?? action.payload?.metadata?.seed?.name,
            version: desiredSeed.version ?? action.payload?.metadata?.seed?.version ?? 1,
            resourceKey: desiredSeed.resourceKey ?? action.key,
            lastAppliedAt: appliedAt,
            manifestHash,
        },
    };
}

export function slugKey(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._/-]+/gu, '-')
        .replace(/^-+|-+$/gu, '') || 'item';
}

export function generatedKey(prefix, ...parts) {
    return `${prefix}:${parts.map(slugKey).join('/')}`;
}

export function seededKey(metadata, fallback) {
    const key = metadata?.seed?.resourceKey;
    return typeof key === 'string' && key.trim() ? key.trim() : fallback;
}

export function maybeAssign(target, key, value) {
    if (value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')) {
        target[key] = value;
    }
}

export function pruneNullish(value) {
    if (Array.isArray(value))
        return value.map(pruneNullish);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([, entry]) => entry !== undefined && entry !== null)
        .map(([key, entry]) => [key, pruneNullish(entry)]));
}

export function sortBy(...selectors) {
    return (left, right) => {
        for (const selector of selectors) {
            const result = String(selector(left) ?? '').localeCompare(String(selector(right) ?? ''));
            if (result !== 0)
                return result;
        }
        return 0;
    };
}

export function emptyObjectAsNull(value) {
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 ? null : value ?? null;
}
