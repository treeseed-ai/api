

export function readArg(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

export function hasArg(name) {
    return process.argv.includes(name);
}

export function readNumberArg(name, fallback) {
    const value = readArg(name);
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseOperationKey(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized)
        return null;
    const [namespace, operation] = normalized.split(':');
    if (!namespace || !operation) {
        throw new Error(`Invalid --operation value "${normalized}". Expected namespace:operation.`);
    }
    return `${namespace}:${operation}`;
}

export function parseRunnerOptions() {
    return {
        once: hasArg('--once'),
        watch: hasArg('--watch'),
        operationId: readArg('--operation-id'),
        operationKey: parseOperationKey(readArg('--operation')),
        pollIntervalMs: readNumberArg('--poll-interval-ms', 5000),
        maxJobs: readNumberArg('--max-jobs', 1),
        planOnly: hasArg('--plan'),
    };
}
