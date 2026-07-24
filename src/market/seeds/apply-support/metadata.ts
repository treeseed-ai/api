import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function manifestHashFor(path) {
    return createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex');
}

export function exportMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object')
        return undefined;
    const { seed: _seed, ...rest } = metadata;
    return Object.keys(rest).length > 0 ? rest : undefined;
}

export function normalizeExportEnvironments(environments) {
    const raw = Array.isArray(environments)
        ? environments
        : typeof environments === 'string'
            ? environments.split(',')
            : ['local', 'staging', 'prod'];
    const selected = raw.map((entry) => String(entry).trim()).filter(Boolean).filter((entry) => ['local', 'staging', 'prod'].includes(entry));
    return [...new Set(selected.length ? selected : ['local', 'staging', 'prod'])];
}

export function actorId(actor) {
    return typeof actor?.principal?.id === 'string' ? actor.principal.id : typeof actor?.id === 'string' ? actor.id : null;
}

export function actorType(actor) {
    return actor?.actorType ?? actor?.type ?? 'local';
}

export function manifestRefIsAllowed(seedName, manifestRef) {
    return manifestRef === undefined || manifestRef === null || manifestRef === '' || manifestRef === `seeds/${seedName}.yaml`;
}
