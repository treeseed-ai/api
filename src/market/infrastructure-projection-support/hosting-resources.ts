import { anchorPart, compact, describeState, safeArray, toneForState } from '../operations/operational-artifacts.js';
import { type InfrastructureBundle, type InfrastructureItem } from '../projects/hosting/infrastructure-projection.js';
import { latestDate, projectName } from './index.js';

export function hostItem(host: any): InfrastructureItem {
    const id = compact(host?.id, compact(host?.name, compact(host?.provider, 'host')));
    return {
        id: `host-${anchorPart(id)}`,
        title: compact(host?.name, compact(host?.accountLabel, compact(host?.provider, 'Host'))),
        description: describeState(host?.status ?? host?.ownership, 'configured'),
        category: 'infrastructure',
        state: compact(host?.status, compact(host?.ownership, 'configured')),
        tone: toneForState(host?.status ?? 'active'),
        href: `/app#host-${anchorPart(id)}`,
        meta: compact(host?.provider, compact(host?.ownership, 'host')),
    };
}

export function providerItem(provider: any): InfrastructureItem {
    return {
        id: `provider-${anchorPart(provider?.id ?? provider?.name)}`,
        title: compact(provider?.name, compact(provider?.provider, 'Capacity provider')),
        description: `${describeState(provider?.status, 'configured')} - ${describeState(provider?.billingScope, 'team')}`,
        category: 'infrastructure',
        state: compact(provider?.status, 'configured'),
        tone: toneForState(provider?.status ?? 'active'),
        href: provider?.id ? `/app/capacity/providers/${encodeURIComponent(provider.id)}/edit` : '/app/capacity/providers',
        meta: compact(provider?.provider, compact(provider?.kind, 'capacity')),
        details: {
            billingScope: compact(provider?.billingScope, 'team'),
            defaultEnvironment: compact(provider?.defaultEnvironment, ''),
        },
    };
}

export function providerDetailItems(detail: any): InfrastructureItem[] {
    const providerId = compact(detail.provider?.id, compact(detail.provider?.name, 'provider'));
    return [
        ...safeArray(detail.hosts).map((host: any) => ({
            id: `provider-host-${anchorPart(providerId)}-${anchorPart(host?.id ?? host?.hostId ?? host?.role)}`,
            title: `${compact(detail.provider?.name, 'Capacity')} host binding`,
            description: describeState(host?.state ?? host?.status, 'configured'),
            category: 'infrastructure' as const,
            state: compact(host?.state, compact(host?.status, 'configured')),
            tone: toneForState(host?.state ?? host?.status ?? 'active'),
            href: `/app#host-${anchorPart(host?.hostId ?? host?.id)}`,
            meta: compact(host?.role, 'host'),
        })),
    ];
}

export function workerItems(bundle: InfrastructureBundle): InfrastructureItem[] {
    const tasks = safeArray(bundle.agents?.taskHealth?.activeTasks).map((task: any) => ({
        id: `queue-${anchorPart(task?.id ?? task?.workDayId ?? task?.type)}`,
        title: `${projectName(bundle)} ${describeState(task?.type, 'task')}`,
        description: describeState(task?.state, 'queued'),
        category: 'execution' as const,
        state: compact(task?.state, 'queued'),
        tone: toneForState(task?.state),
        href: task?.workDayId ? `/app/projects/${encodeURIComponent(task.workDayId)}` : '/app/projects',
        meta: describeState(task?.priority, 'task'),
        timestamp: latestDate(task?.updatedAt, task?.createdAt),
        projectId: compact(bundle.project?.id, '') || null,
        projectName: projectName(bundle),
    }));
    return tasks;
}
