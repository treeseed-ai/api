import { anchorPart, compact, describeState, safeArray, toneForState } from '../operations/operational-artifacts.js';
import { type InfrastructureBundle, type InfrastructureItem } from '../projects/hosting/infrastructure-projection.js';
import { projectName } from './index.js';

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
