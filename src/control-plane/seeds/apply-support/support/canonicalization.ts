

export function isoNow() {
    return new Date().toISOString();
}

export function stableJson(value: Record<string, unknown> | readonly unknown[]): string;
export function stableJson(value: unknown): string | undefined;
export function stableJson(value: unknown): string | undefined {
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

export function stripSeedRuntimeMetadata(metadata: unknown) {
    const source = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
    const seed = source.seed && typeof source.seed === 'object' ? source.seed as Record<string, unknown> : null;
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

export function comparablePayload(payload: Record<string, unknown> | null | undefined) {
    const next = { ...(payload ?? {}) };
    // Stable resource keys identify plan actions; they are not persisted resource state.
    delete next.key;
    if (next.metadata && typeof next.metadata === 'object') {
        next.metadata = stripSeedRuntimeMetadata(next.metadata);
    }
    return next;
}

export function actionIsUnchanged(action: { payload: Record<string, unknown> }, currentPayload: Record<string, unknown> | null | undefined) {
    return stableJson(comparablePayload(action.payload)) === stableJson(comparablePayload(currentPayload));
}

export function mergeSeedMetadata(existingMetadata: unknown, desiredMetadata: (Record<string, unknown> & { seed?: Record<string, unknown> }) | null | undefined, action: {
    key: string; payload?: { metadata?: { seed?: { name?: unknown; version?: unknown } } };
}, manifestHash: unknown, appliedAt: unknown) {
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

export function projectSeedMetadata(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const { metadata,kind: _kind,repository: _repository,architecture: _architecture,...own } = value as Record<string, unknown>;
	return {
		...projectSeedMetadata(metadata),
		...own,
	};
}

export function projectSeedMetadataRequiresMigration(value: unknown) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
	const metadata = source?.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
		? source.metadata as Record<string, unknown> : null;
	return Boolean(metadata?.metadata && typeof metadata.metadata === 'object' && !Array.isArray(metadata.metadata));
}

export function slugKey(value: unknown) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._/-]+/gu, '-')
        .replace(/^-+|-+$/gu, '') || 'item';
}

export function generatedKey(prefix: string, ...parts: unknown[]) {
    return `${prefix}:${parts.map(slugKey).join('/')}`;
}

export function seededKey<T>(metadata: { seed?: { resourceKey?: unknown } } | null | undefined, fallback: T) {
    const key = metadata?.seed?.resourceKey;
    return typeof key === 'string' && key.trim() ? key.trim() : fallback;
}

export function maybeAssign(target: Record<string, unknown>, key: string, value: unknown) {
    if (value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')) {
        target[key] = value;
    }
}

export function pruneNullish(value: Record<string, unknown>): Record<string, unknown>;
export function pruneNullish(value: readonly unknown[]): unknown[];
export function pruneNullish(value: unknown): unknown;
export function pruneNullish(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(pruneNullish);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([, entry]) => entry !== undefined && entry !== null)
        .map(([key, entry]) => [key, pruneNullish(entry)]));
}

export function sortBy<T>(...selectors: Array<(value: T) => unknown>) {
    return (left: T, right: T) => {
        for (const selector of selectors) {
            const result = String(selector(left) ?? '').localeCompare(String(selector(right) ?? ''));
            if (result !== 0)
                return result;
        }
        return 0;
    };
}

export function emptyObjectAsNull(value: unknown) {
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 ? null : value ?? null;
}
