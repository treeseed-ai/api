import { compact, compareDatesDesc } from '../operations/operational-artifacts.js';
import { type InfrastructureBundle, type InfrastructureItem } from '../projects/hosting/infrastructure-projection.js';

export async function call(store: any, method: string, ...args: any[]) {
    return typeof store?.[method] === 'function' ? store[method](...args).catch(() => null) : null;
}

export function latestDate(...values: unknown[]): string | null {
    return values.map((value) => compact(value, '')).find(Boolean) ?? null;
}

export function compareItemDesc(left: InfrastructureItem, right: InfrastructureItem) {
    return compareDatesDesc(left.timestamp, right.timestamp);
}

export function repositoryLabel(repository: any): string {
    if (typeof repository === 'string')
        return repository;
    return [repository?.owner, repository?.name ?? repository?.repo ?? repository?.role].filter(Boolean).join('/');
}

export function projectName(bundle: InfrastructureBundle) {
    return compact(bundle.project?.name, compact(bundle.project?.slug, 'Project'));
}

export function seedSummary(plan: any) {
    const summary = plan?.summary;
    if (!summary)
        return 'Seed plan available for operator review.';
    const creates = Number(summary.create ?? summary.created ?? 0);
    const updates = Number(summary.update ?? summary.updated ?? 0);
    const skips = Number(summary.skip ?? summary.skipped ?? 0);
    return `${creates} create, ${updates} update, ${skips} skip actions planned.`;
}

export function titleFromEvent(value: unknown) {
    return compact(value, 'Audit event')
        .replace(/([a-z])([A-Z])/gu, '$1 $2')
        .replace(/[_-]+/gu, ' ')
        .replace(/\b\w/gu, (match) => match.toUpperCase());
}

export function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
    const seen = new Set<string>();
    const result: T[] = [];
    for (const item of items) {
        const id = key(item);
        if (!id || seen.has(id))
            continue;
        seen.add(id);
        result.push(item);
    }
    return result;
}
