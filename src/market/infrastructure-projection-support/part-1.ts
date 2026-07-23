import { anchorPart, compact, compareDatesDesc, describeState, safeArray, toneForState, type OperationalTone, } from '../operational-artifacts.js';
import type { BuildInfrastructureProjectionInput, InfrastructureBundle, InfrastructureItem, InfrastructureProjection } from '../infrastructure-projection.js';
import { diagnosticsFromHosts, diagnosticsFromSeeds, auditDiagnosticItem, emptyProjection, call, latestDate, compareItemDesc, repositoryLabel, projectName, seedSummary, titleFromEvent, dedupeBy } from './index.js';

export async function loadProjectBundle(input: BuildInfrastructureProjectionInput, project: any): Promise<InfrastructureBundle> {
    const store = input.store;
    const [summary, details, agents, releases, capacityOperations] = await Promise.all([
        call(store, 'getProjectSummary', project.id, input.principal),
        call(store, 'getProjectDetails', project.id),
        call(store, 'getProjectAgentsSummary', project.id, input.principal),
        call(store, 'getProjectReleasesSummary', project.id, input.principal),
        call(store, 'getProjectCapacityOperations', project.id, 'staging'),
    ]);
    return { project, summary, details, agents, releases, capacityOperations };
}

export function projectItem(project: any): InfrastructureItem {
    return {
        id: `project-${compact(project?.id, compact(project?.slug, 'project'))}`,
        title: compact(project?.name, compact(project?.slug, 'Project')),
        description: compact(project?.description, 'Operational project context.'),
        category: 'infrastructure',
        state: compact(project?.status, 'active'),
        tone: toneForState(project?.status ?? 'active'),
        href: `/app/projects/${encodeURIComponent(anchorPart(project?.id ?? project?.slug))}/settings`,
        meta: compact(project?.slug, 'project'),
        projectId: compact(project?.id, '') || null,
        projectName: compact(project?.name, compact(project?.slug, 'Project')),
    };
}

export function repositoryItems(bundle: InfrastructureBundle): InfrastructureItem[] {
    const summaryRepos = safeArray(bundle.summary?.repositories);
    const detailRepos = safeArray(bundle.details?.repositories);
    return dedupeBy([...summaryRepos, ...detailRepos], (repository) => compact(repository?.id, repositoryLabel(repository)))
        .map((repository) => ({
        id: `repository-${anchorPart(repository?.id ?? repositoryLabel(repository))}`,
        title: repositoryLabel(repository) || 'Repository',
        description: `${projectName(bundle)} - ${describeState(repository?.status ?? repository?.state, 'connected')}`,
        category: 'infrastructure' as const,
        state: compact(repository?.status, compact(repository?.state, 'connected')),
        tone: toneForState(repository?.status ?? repository?.state ?? 'active'),
        href: '/app/hosts',
        meta: compact(repository?.role, compact(repository?.provider, 'repository')),
        projectId: compact(bundle.project?.id, '') || null,
        projectName: projectName(bundle),
    }));
}

export function deploymentItems(bundle: InfrastructureBundle): InfrastructureItem[] {
    const deployments = [
        ...safeArray(bundle.releases?.history),
        ...safeArray(bundle.details?.deployments),
        bundle.summary?.latestProdDeployment,
        bundle.summary?.latestStagingDeployment,
    ].filter(Boolean);
    return dedupeBy(deployments, (deployment) => compact(deployment?.id, `${deployment?.environment ?? 'deployment'}-${deployment?.releaseTag ?? deployment?.sourceRef ?? ''}`))
        .map((deployment) => ({
        id: `deployment-${anchorPart(bundle.project?.id)}-${anchorPart(deployment?.id ?? deployment?.releaseTag ?? deployment?.environment)}`,
        title: `${projectName(bundle)} ${compact(deployment?.environment, 'deployment')}`,
        description: compact(deployment?.releaseTag, compact(deployment?.sourceRef, describeState(deployment?.status, 'deployment recorded'))),
        category: 'infrastructure' as const,
        state: compact(deployment?.status, 'recorded'),
        tone: toneForState(deployment?.status),
        timestamp: latestDate(deployment?.finishedAt, deployment?.completedAt, deployment?.startedAt, deployment?.createdAt),
        href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/hosts` : '/app/projects',
        meta: compact(deployment?.deploymentKind, compact(deployment?.environment, 'deployment')),
        projectId: compact(bundle.project?.id, '') || null,
        projectName: projectName(bundle),
    }));
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

export function capacityOperationItems(bundle: InfrastructureBundle): InfrastructureItem[] {
    const operations = bundle.capacityOperations;
    if (!operations)
        return [];
    const summary = operations.summary;
    return [
        summary ? {
            id: `capacity-summary-${anchorPart(bundle.project?.id)}`,
            title: `${projectName(bundle)} capacity readiness`,
            description: safeArray(summary.reasons).join(', ') || describeState(summary.readiness, 'ready'),
            category: 'infrastructure' as const,
            state: compact(summary.readiness, 'ready'),
            tone: toneForState(summary.readiness),
            href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/settings` : '/app/projects',
            meta: 'readiness',
            projectId: compact(bundle.project?.id, '') || null,
            projectName: projectName(bundle),
        } : null,
        ...safeArray(operations.interruptionReservations).map((reservation: any) => ({
            id: `capacity-reservation-${anchorPart(reservation?.id ?? reservation?.taskId)}`,
            title: `${projectName(bundle)} continuation required`,
            description: describeState(reservation?.state, 'reserved capacity'),
            category: 'execution' as const,
            state: compact(reservation?.state, 'reserved'),
            tone: toneForState(reservation?.state ?? 'warning'),
            href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/settings` : '/app/projects',
            meta: 'reservation',
            projectId: compact(bundle.project?.id, '') || null,
            projectName: projectName(bundle),
        })),
    ].filter(Boolean) as InfrastructureItem[];
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

export function projectResourceItem(bundle: InfrastructureBundle, resource: any): InfrastructureItem {
    const id = compact(resource?.id, compact(resource?.logicalName, compact(resource?.name, 'resource')));
    return {
        id: `resource-${anchorPart(id)}`,
        title: compact(resource?.logicalName, compact(resource?.name, compact(resource?.resourceKind, 'Infrastructure resource'))),
        description: `${projectName(bundle)} - ${describeState(resource?.status, 'configured')}`,
        category: 'infrastructure',
        state: compact(resource?.status, 'configured'),
        tone: toneForState(resource?.status ?? 'active'),
        href: `/app/knowledge/artifacts#resource-${anchorPart(id)}`,
        meta: compact(resource?.provider, compact(resource?.resourceKind, 'resource')),
        projectId: compact(bundle.project?.id, '') || null,
        projectName: projectName(bundle),
    };
}

export function productItem(product: any): InfrastructureItem {
    const id = compact(product?.id, compact(product?.slug, compact(product?.title, 'resource')));
    return {
        id: `resource-${anchorPart(id)}`,
        title: compact(product?.title, compact(product?.name, compact(product?.slug, 'Operational resource'))),
        description: compact(product?.summary, describeState(product?.kind, 'Reusable operational asset')),
        category: 'knowledge',
        state: compact(product?.visibility, compact(product?.status, 'available')),
        tone: toneForState(product?.visibility === 'public' ? 'active' : product?.status),
        href: `/app/knowledge/artifacts#resource-${anchorPart(id)}`,
        meta: compact(product?.kind, 'resource'),
    };
}

export function policyItems(bundle: InfrastructureBundle): InfrastructureItem[] {
    return [
        ...safeArray(bundle.summary?.capabilityGrants).map((grant: any) => ({
            id: `policy-${anchorPart(grant?.id ?? grant?.operation)}`,
            title: compact(grant?.label, `${compact(grant?.namespace, 'operation')}.${compact(grant?.operation, 'policy')}`),
            description: compact(grant?.approvalPolicy?.reason, describeState(grant?.defaultDispatchMode, 'operational policy')),
            category: 'governance' as const,
            state: grant?.enabled === false ? 'paused' : 'active',
            tone: grant?.enabled === false ? 'warning' as const : 'success' as const,
            href: `/app/work/decisions#policy-${anchorPart(grant?.id ?? grant?.operation)}`,
            meta: projectName(bundle),
            projectId: compact(bundle.project?.id, '') || null,
            projectName: projectName(bundle),
        })),
        ...(bundle.capacityOperations?.summary?.workPolicy ? [{
                id: `policy-work-${anchorPart(bundle.project?.id)}`,
                title: `${projectName(bundle)} work policy`,
                description: describeState(bundle.capacityOperations.summary.workPolicy.enabled === false ? 'paused' : 'active', 'work policy'),
                category: 'governance' as const,
                state: bundle.capacityOperations.summary.workPolicy.enabled === false ? 'paused' : 'active',
                tone: bundle.capacityOperations.summary.workPolicy.enabled === false ? 'warning' as const : 'success' as const,
                href: `/app/work/decisions#policy-work-${anchorPart(bundle.project?.id)}`,
                meta: compact(bundle.capacityOperations.summary.workPolicy.environment, 'staging'),
                projectId: compact(bundle.project?.id, '') || null,
                projectName: projectName(bundle),
            }] : []),
    ];
}

export function seedItems(seedState: any): InfrastructureItem[] {
    if (!seedState)
        return [];
    return [
        {
            id: 'seed-plan',
            title: `Seed ${compact(seedState.selectedSeed, 'treeseed')}`,
            description: seedState.error ?? seedSummary(seedState.plan),
            category: 'infrastructure',
            state: seedState.error ? 'blocked' : safeArray(seedState.diagnostics).some((diagnostic: any) => diagnostic.severity === 'error') ? 'needs_review' : 'planned',
            tone: seedState.error ? 'danger' : safeArray(seedState.diagnostics).length ? 'warning' : 'success',
            href: '/app#seed-plan',
            meta: compact(seedState.selectedEnvironments, 'environment'),
        },
        ...safeArray(seedState.runs).map((run: any) => ({
            id: `seed-run-${anchorPart(run?.id ?? run?.manifestHash)}`,
            title: `Seed run ${compact(run?.id, compact(run?.manifestHash, 'record'))}`,
            description: describeState(run?.status ?? run?.state, 'recorded'),
            category: 'infrastructure' as const,
            state: compact(run?.status, compact(run?.state, 'recorded')),
            tone: toneForState(run?.status ?? run?.state),
            timestamp: latestDate(run?.updatedAt, run?.createdAt),
            href: `/app#seed-run-${anchorPart(run?.id ?? run?.manifestHash)}`,
            meta: 'seed run',
        })),
        ...safeArray(seedState.approvals).map((approval: any) => ({
            id: `seed-approval-${anchorPart(approval?.id)}`,
            title: compact(approval?.title, 'Seed approval'),
            description: compact(approval?.summary, 'Approval required for seed operation.'),
            category: 'governance' as const,
            state: compact(approval?.state, 'pending'),
            tone: toneForState(approval?.state ?? approval?.severity),
            timestamp: latestDate(approval?.createdAt, approval?.updatedAt),
            href: approval?.id ? `/app/work/decisions/${encodeURIComponent(approval.id)}` : '/app/work/decisions',
            meta: describeState(approval?.severity, 'review'),
        })),
    ];
}

export function diagnosticsFromCapacity(teamCapacitySummary: any, bundles: InfrastructureBundle[]): InfrastructureItem[] {
    const teamDiagnostic = teamCapacitySummary && !['ready', 'active'].includes(compact(teamCapacitySummary.readiness, '').toLowerCase())
        ? [{
                id: 'diagnostic-team-capacity',
                title: 'Team capacity requires attention',
                description: safeArray(teamCapacitySummary.reasons).join(', ') || describeState(teamCapacitySummary.readiness, 'capacity state'),
                category: 'infrastructure' as const,
                state: compact(teamCapacitySummary.readiness, 'review'),
                tone: toneForState(teamCapacitySummary.readiness),
                href: '/app/projects',
                meta: 'capacity',
            }]
        : [];
    return teamDiagnostic;
}

export function diagnosticsFromDeployments(deployments: InfrastructureItem[]): InfrastructureItem[] {
    return deployments.filter((deployment) => ['failed', 'blocked'].includes(compact(deployment.state, '').toLowerCase()))
        .map((deployment) => ({
        ...deployment,
        id: `diagnostic-${deployment.id}`,
        title: `${deployment.title} needs attention`,
        href: '/app/projects',
    }));
}
