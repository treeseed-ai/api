import { type GovernanceBundle, type GovernanceCapacityConstraint } from '../governance-projection.js';
import { safeArray, compact, latestDate, describeState, toneForState } from './index.js';

export function capacityConstraintsForBundle(bundle: GovernanceBundle): GovernanceCapacityConstraint[] {
    const operations = bundle.capacityOperations;
    if (!operations)
        return [];
    const readiness = operations.summary?.readiness;
    const readinessEvents = readiness && readiness !== 'ready' ? [{
            id: `capacity-readiness-${bundle.project?.id}`,
            title: `${compact(bundle.project?.name, 'Project')} capacity readiness`,
            description: safeArray(operations.summary?.reasons).join(', ') || describeState(readiness, 'capacity constraint'),
            category: 'governance' as const,
            phase: 'governance' as const,
            state: readiness,
            tone: toneForState(readiness),
            timestamp: null,
            href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/guidance` : '/app/work/decisions',
            meta: compact(bundle.project?.name, 'capacity'),
            projectId: compact(bundle.project?.id, '') || null,
            projectName: compact(bundle.project?.name, ''),
            constraintType: 'readiness',
        }] : [];
    const reservations = safeArray(operations.interruptionReservations).map((reservation: any) => ({
        id: `capacity-reservation-${reservation.id}`,
        title: 'Execution interrupted by capacity policy',
        description: describeState(reservation.state, 'Capacity reservation needs review.'),
        category: 'governance' as const,
        phase: 'governance' as const,
        state: compact(reservation.state, 'pending'),
        tone: toneForState(reservation.state),
        timestamp: latestDate(reservation.createdAt, reservation.updatedAt),
        href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/guidance` : '/app/work/decisions',
        meta: compact(bundle.project?.name, 'capacity'),
        governanceRefs: [],
        projectId: compact(bundle.project?.id, '') || null,
        projectName: compact(bundle.project?.name, ''),
        constraintType: 'reservation',
    }));
    return [...readinessEvents, ...reservations];
}
