import { compact, safeArray, uniqueStrings, type OperationalArtifact } from '../operational-artifacts.js';

export function repositoryContextFor(bundle: any, artifacts: OperationalArtifact[]) {
    const repositories = safeArray(bundle.projectSummary?.repositories).map((repository: any) => ({
        ...repository,
        href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}` : '/app/projects',
        projectName: compact(bundle.project?.name, compact(bundle.project?.slug, 'Project')),
    }));
    const artifactRefs = uniqueStrings(artifacts.flatMap((artifact) => artifact.repositories));
    if (artifactRefs.length === 0)
        return repositories;
    return [
        ...repositories,
        {
            id: `refs-${bundle.workday.id}`,
            title: 'Referenced operational files',
            description: `${artifactRefs.slice(0, 4).join(', ')}${artifactRefs.length > 4 ? ` and ${artifactRefs.length - 4} more` : ''}`,
            meta: `${artifactRefs.length} reference${artifactRefs.length === 1 ? '' : 's'}`,
            status: 'referenced',
            tone: 'info',
            href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}#development` : '/app/projects',
        },
    ];
}
