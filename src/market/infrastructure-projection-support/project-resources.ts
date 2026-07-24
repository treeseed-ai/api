import { anchorPart, compact, describeState, safeArray, toneForState } from '../operations/operational-artifacts.js';
import { type InfrastructureBundle, type InfrastructureItem } from '../projects/hosting/infrastructure-projection.js';
import { latestDate, repositoryLabel, projectName, dedupeBy } from './index.js';

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
