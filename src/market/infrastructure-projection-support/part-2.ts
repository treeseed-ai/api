import { anchorPart, compact, compareDatesDesc, describeState, safeArray, toneForState, type OperationalTone, } from '../operational-artifacts.js';
import type { InfrastructureBundle, InfrastructureItem, InfrastructureProjection } from '../infrastructure-projection.js';
import { loadProjectBundle, projectItem, repositoryItems, deploymentItems, providerItem, providerDetailItems, capacityOperationItems, workerItems, hostItem, projectResourceItem, productItem, policyItems, seedItems, diagnosticsFromCapacity, diagnosticsFromDeployments } from './index.js';

export function diagnosticsFromHosts(hosts: InfrastructureItem[]): InfrastructureItem[] {
    return hosts.filter((host) => ['failed', 'inactive', 'missing', 'blocked'].includes(compact(host.state, '').toLowerCase()))
        .map((host) => ({
        ...host,
        id: `diagnostic-${host.id}`,
        title: `${host.title} host issue`,
        href: '/app',
    }));
}

export function diagnosticsFromSeeds(seedState: any): InfrastructureItem[] {
    return safeArray(seedState?.diagnostics).map((diagnostic: any, index) => ({
        id: `diagnostic-seed-${index}`,
        title: compact(diagnostic?.code, 'Seed diagnostic'),
        description: compact(diagnostic?.message, describeState(diagnostic?.severity, 'diagnostic')),
        category: 'infrastructure',
        state: compact(diagnostic?.severity, 'info'),
        tone: diagnostic?.severity === 'error' ? 'danger' : diagnostic?.severity === 'warning' ? 'warning' : 'info',
        href: '/app',
        meta: compact(diagnostic?.path, 'seed'),
    }));
}

export function auditDiagnosticItem(event: any): InfrastructureItem {
    const id = compact(event?.id, compact(event?.eventType, 'audit'));
    return {
        id: `audit-${anchorPart(id)}`,
        title: titleFromEvent(event?.eventType),
        description: compact(event?.data?.summary, describeState(event?.targetType, 'audit event')),
        category: 'governance',
        state: compact(event?.eventType, 'recorded'),
        tone: 'info',
        timestamp: latestDate(event?.createdAt),
        href: '/app/work/decisions',
        meta: 'audit',
    };
}

export function emptyProjection(): InfrastructureProjection {
    return {
        metrics: [],
        projects: [],
        repositories: [],
        deployments: [],
        capacity: [],
        workers: [],
        hosts: [],
        integrations: [],
        resources: [],
        seeds: [],
        policies: [],
        diagnostics: [],
    };
}

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
