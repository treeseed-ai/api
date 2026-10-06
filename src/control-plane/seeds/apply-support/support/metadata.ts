import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PathLike } from 'node:fs';

export function manifestHashFor(path: PathLike) {
    return createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex');
}

export function exportMetadata(metadata: unknown) {
    if (!metadata || typeof metadata !== 'object')
        return undefined;
    const { seed: _seed, ...rest } = metadata as Record<string, unknown>;
    return Object.keys(rest).length > 0 ? rest : undefined;
}

export function normalizeExportEnvironments(environments: unknown) {
    const raw = Array.isArray(environments)
        ? environments
        : typeof environments === 'string'
            ? environments.split(',')
            : ['local', 'staging', 'prod'];
    const selected = raw.map((entry) => String(entry).trim()).filter(Boolean).filter((entry) => ['local', 'staging', 'prod'].includes(entry));
    return [...new Set(selected.length ? selected : ['local', 'staging', 'prod'])];
}

export function actorId(actor: { principal?: { id?: unknown }; id?: unknown } | null | undefined) {
    return typeof actor?.principal?.id === 'string' ? actor.principal.id : typeof actor?.id === 'string' ? actor.id : null;
}

export function actorType(actor: { actorType?: string; type?: string } | null | undefined) {
    return actor?.actorType ?? actor?.type ?? 'local';
}

export function manifestRefIsAllowed(seedName: string, manifestRef: unknown) {
    return manifestRef === undefined || manifestRef === null || manifestRef === '' || manifestRef === `seeds/${seedName}.yaml`;
}
