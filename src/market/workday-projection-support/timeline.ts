import { compact, compareDatesAsc, describeState, latestDate, safeArray, titleFromKind, toneForState, type OperationalArtifact } from '../operational-artifacts.js';
import { type OperationalTimelineEvent } from '../workday-projection.js';
import { modeRunArtifactRefs, phaseForEvent, phaseForAssignment, categoryForPhase } from './index.js';

export function assignmentTimelineEvents(entry: any): OperationalTimelineEvent[] {
    const assignment = entry.assignment;
    const phase = phaseForAssignment(assignment);
    const runs = safeArray(entry.modeRuns);
    if (runs.length === 0) {
        return [{
                id: `assignment-${assignment.id}`,
                title: titleFromKind(assignment?.mode, 'Assignment'),
                description: `Assignment state: ${describeState(assignment?.status, 'recorded')}.`,
                category: categoryForPhase(phase),
                phase,
                state: compact(assignment?.status, 'recorded'),
                tone: toneForState(assignment?.status),
                timestamp: latestDate(assignment?.leaseClaimedAt, assignment?.createdAt, assignment?.updatedAt),
                meta: titleFromKind(assignment?.mode, 'Assignment'),
            }];
    }
    return runs.map((run: any) => ({
        id: `mode-run-${compact(run?.id, `${assignment.id}-run`)}`,
        title: titleFromKind(run?.handlerId ?? run?.handler_id, titleFromKind(run?.mode ?? assignment?.mode, 'Mode run')),
        description: `${titleFromKind(run?.mode ?? assignment?.mode)} execution ${describeState(run?.status, 'recorded')}.`,
        category: categoryForPhase(phaseForEvent(run?.handlerId ?? run?.mode, assignment?.mode)),
        phase: phaseForEvent(run?.handlerId ?? run?.mode, assignment?.mode),
        state: compact(run?.status ?? assignment?.status, 'recorded'),
        tone: toneForState(run?.status ?? assignment?.status),
        timestamp: latestDate(run?.startedAt, run?.completedAt, run?.failedAt, run?.createdAt, assignment?.updatedAt),
        meta: titleFromKind(run?.executionProviderId ?? assignment?.executionProviderId ?? assignment?.mode, 'Execution'),
        artifactRefs: modeRunArtifactRefs(run),
    }));
}

export function governanceEvent(approval: any): OperationalTimelineEvent {
    const id = compact(approval?.id, 'approval');
    return {
        id: `approval-${id}`,
        title: compact(approval?.title, 'Approval requested'),
        description: compact(approval?.summary, titleFromKind(approval?.kind, 'Operational review')),
        category: 'governance',
        phase: 'governance',
        state: compact(approval?.state, 'pending'),
        tone: toneForState(approval?.state ?? approval?.severity),
        timestamp: latestDate(approval?.createdAt, approval?.decidedAt, approval?.updatedAt),
        href: `/app/work/decisions/${encodeURIComponent(id)}`,
        meta: `${describeState(approval?.severity, 'review')} severity`,
        governanceRefs: [id],
    };
}

export function objectiveEvent(workday: any): OperationalTimelineEvent {
    return {
        id: `workday-${workday.id}-objective`,
        title: 'Objective received',
        description: workday.objective,
        category: 'objective',
        phase: 'research',
        state: 'received',
        tone: 'info',
        timestamp: latestDate(workday.startedAt, workday.createdAt, workday.updatedAt),
        meta: workday.environment,
    };
}

export function artifactTimelineEvent(artifact: OperationalArtifact): OperationalTimelineEvent {
    return {
        id: `artifact-${artifact.id}`,
        title: artifact.title,
        description: artifact.description,
        category: 'knowledge',
        phase: 'knowledge',
        state: artifact.state,
        tone: artifact.tone,
        timestamp: artifact.createdAt,
        href: artifact.href,
        meta: artifact.type,
        artifactRefs: [artifact.id],
        repositoryRefs: artifact.repositories,
    };
}

export function compareTimelineAsc(left: OperationalTimelineEvent, right: OperationalTimelineEvent): number {
    return compareDatesAsc(left.timestamp, right.timestamp);
}
