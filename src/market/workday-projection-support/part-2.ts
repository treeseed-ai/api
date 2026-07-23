import { compact, compareDatesAsc, describeState, latestDate, normalizeOperationalArtifact, safeArray, titleFromKind, toneForState, uniqueStrings, type OperationalArtifact, type OperationalTone, } from '../operational-artifacts.js';
import { MAX_CAPACITY_PAGE_LIMIT } from '@treeseed/sdk/capacity-pagination';
import type { OperationalPhase, OperationalPhaseKey, OperationalTimelineEvent, WorkdayProjection } from '../workday-projection.js';
import { phaseDefinitions, boundedProjectionPage, boundedEvidencePage, loadProjectWorkdayBundle, projectWorkdayProjection, agentActivityProjection, collectArtifacts, normalizeArtifact, assignmentTimelineEvents, governanceEvent, objectiveEvent, artifactTimelineEvent, buildPhases } from './index.js';

export function phaseState(phase: OperationalPhaseKey, events: OperationalTimelineEvent[], artifacts: OperationalArtifact[], governance: OperationalTimelineEvent[], workday: any): string {
    const workdayState = compact(workday?.state, '').toLowerCase();
    if (workdayState === 'failed' || workdayState === 'rejected')
        return workdayState;
    if (events.some((event) => ['failed', 'blocked', 'rejected'].includes(compact(event.state).toLowerCase())))
        return 'blocked';
    if (phase === 'governance' && governance.some((event) => ['pending', 'under_review', 'escalated'].includes(compact(event.state).toLowerCase())))
        return 'pending';
    if (phase === 'knowledge' && artifacts.some((artifact) => ['published', 'approved'].includes(compact(artifact.state).toLowerCase())))
        return 'completed';
    if (events.some((event) => ['running', 'active', 'claimed', 'executing', 'verifying'].includes(compact(event.state).toLowerCase())))
        return 'active';
    if (events.length > 0 || artifacts.length > 0 || governance.length > 0)
        return 'completed';
    return 'waiting';
}

export function currentPhase(phases: OperationalPhase[], workday: any) {
    const state = compact(workday?.state, '').toLowerCase();
    if (['completed', 'failed', 'rejected'].includes(state))
        return describeState(state, 'Completed');
    const active = phases.find((phase) => ['active', 'pending', 'blocked'].includes(phase.state));
    const waiting = phases.find((phase) => phase.state === 'waiting');
    return active?.label ?? waiting?.label ?? 'Knowledge';
}

export function capacityProjection(bundle: any) {
    const ledgerEntries = safeArray(bundle.ledgerEntries);
    const reservations = safeArray(bundle.reservations).filter((reservation: any) => !workdayRef(reservation) || workdayRef(reservation) === bundle.workday.id);
    const usageActuals = safeArray(bundle.usageActuals);
    const derivedEntries = safeArray(bundle.capacitySummary?.derivedCapacity?.entries ?? bundle.capacityOperations?.diagnostics?.derivedCapacity?.entries);
    const nativeUsage = usageActuals.map((actual: any) => ({
        id: compact(actual?.id, compact(actual?.taskId, 'usage')),
        taskId: compact(actual?.taskId ?? actual?.task_id, ''),
        nativeUnit: compact(actual?.nativeUsage?.nativeUnit ?? actual?.native_usage?.nativeUnit ?? actual?.nativeUnit, ''),
        amount: numberOrNull(actual?.nativeUsage?.amount ?? actual?.nativeUsage?.nativeAmount ?? actual?.nativeUsage?.usd ?? actual?.nativeUsage?.wallMinutes ?? actual?.nativeUsage?.quotaMinutes),
        actualCredits: numberOrNull(actual?.actualCredits ?? actual?.actual_credits),
        source: compact(actual?.actualCreditsSource ?? actual?.actual_credits_source ?? actual?.source, ''),
    }));
    return {
        summary: bundle.capacitySummary ?? null,
        ledgerEntries,
        reservations,
        usageActuals,
        nativeUsage,
        derivedEntries,
        totalCredits: ledgerEntries.reduce((sum: number, entry: any) => sum + numberValue(entry?.credits, 0), 0),
        totalUsd: ledgerEntries.reduce((sum: number, entry: any) => sum + numberValue(entry?.usd, 0), 0),
        totalReservedNative: reservations.reduce((sum: number, reservation: any) => sum + numberValue(reservation?.reservedNativeAmount, 0), 0),
        totalConsumedNative: reservations.reduce((sum: number, reservation: any) => sum + numberValue(reservation?.consumedNativeAmount, 0), 0),
    };
}

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

export function normalizeWorkday(project: any, source: any, summaryEntry: any) {
    const metadata = objectValue(source?.metadata) ?? {};
    const envelope = objectValue(source?.envelope) ?? {};
    const summary = objectValue(metadata?.summary) ?? objectValue(envelope?.summary) ?? objectValue(summaryEntry) ?? {};
    const contentSnapshot = objectValue(summary?.contentSnapshot) ?? {};
    const docsAutomation = objectValue(summary?.docsAutomation) ?? {};
    const id = compact(source?.id, 'workday');
    return {
        id,
        recordId: compact(source?.id, id),
        projectId: compact(source?.projectId, compact(project?.id, '')),
        projectName: compact(project?.name, compact(project?.slug, 'Project')),
        projectSlug: compact(project?.slug, ''),
        environment: compact(metadata?.environment, 'staging'),
        kind: compact(source?.kind, 'workday'),
        state: compact(source?.status, 'draft'),
        objective: compact(summary?.objective, compact(summary?.title, compact(contentSnapshot?.title, `Operational workday ${id}`))),
        startedAt: latestDate(source?.startedAt, summary?.startedAt),
        endedAt: latestDate(source?.completedAt, summary?.endedAt),
        updatedAt: latestDate(source?.updatedAt, source?.createdAt),
        summary,
        budget: {
            envelope,
            settlement: objectValue(summaryEntry?.settlement) ?? {},
        },
        docsAutomation,
        contentSnapshot,
        href: project?.id ? `/app/projects/${encodeURIComponent(project.id)}#development` : '/app/projects',
        tone: toneForState(source?.status),
    };
}

export function artifactBelongsToWorkday(artifact: any, workdayId: string, assignmentIds: Set<string>) {
    const relatedWorkday = workdayRef(artifact);
    if (relatedWorkday)
        return relatedWorkday === workdayId;
    const assignmentId = compact(artifact?.assignmentId, compact(artifact?.assignment_id, ''));
    if (assignmentId)
        return assignmentIds.has(assignmentId);
    return false;
}

export function modeRunArtifactRefs(run: any) {
    const outputs = objectValue(run?.outputs) ?? parseJson(run?.outputsJson, {});
    return uniqueStrings([
        ...safeArray(outputs?.artifactRefs),
        ...safeArray(outputs?.artifacts).map((artifact: any) => compact(artifact?.id, '')),
        ...safeArray(outputs?.generatedArtifacts).map((artifact: any) => compact(artifact?.id, '')),
    ]);
}

export function riskClassification(approvals: any[]) {
    const severities = safeArray(approvals).map((approval: any) => compact(approval?.severity, '').toLowerCase());
    if (severities.includes('critical'))
        return 'Critical';
    if (severities.includes('high'))
        return 'High';
    if (severities.includes('moderate') || severities.includes('medium'))
        return 'Moderate';
    if (severities.includes('low'))
        return 'Low';
    return 'Unclassified';
}

export function phaseForEvent(kind: unknown, taskType: unknown): OperationalPhaseKey {
    const value = `${String(kind ?? '')} ${String(taskType ?? '')}`.toLowerCase();
    if (value.includes('approval') || value.includes('governance') || value.includes('policy') || value.includes('escalat'))
        return 'governance';
    if (value.includes('knowledge') || value.includes('report') || value.includes('publish') || value.includes('release') || value.includes('docs'))
        return 'knowledge';
    if (value.includes('verify') || value.includes('test') || value.includes('check') || value.includes('audit'))
        return 'verification';
    if (value.includes('research') || value.includes('analysis') || value.includes('inspect') || value.includes('inventory') || value.includes('discover') || value.includes('graph'))
        return 'research';
    return 'implementation';
}

export function phaseForAssignment(assignment: any): OperationalPhaseKey {
    return phaseForEvent(assignment?.handlerId ?? assignment?.mode, assignment?.mode);
}

export function categoryForPhase(phase: OperationalPhaseKey): OperationalTimelineEvent['category'] {
    if (phase === 'research')
        return 'research';
    if (phase === 'governance')
        return 'governance';
    if (phase === 'knowledge')
        return 'knowledge';
    return 'execution';
}

export function matchesWorkdayId(value: any, id: string) {
    return Boolean(value && (workdayRef(value) === id || compact(value?.id) === id || compact(value?.recordId) === id));
}

export function workdayRef(value: any) {
    return compact(value?.workDayId, compact(value?.work_day_id, ''));
}

export function objectValue(value: any) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function parseJson(value: unknown, fallback: any) {
    if (!value || typeof value !== 'string')
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}

export function numberValue(value: unknown, fallback = 0): number {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
}

export function numberOrNull(value: unknown): number | null {
    const next = Number(value);
    return Number.isFinite(next) ? next : null;
}

export function compareTimelineAsc(left: OperationalTimelineEvent, right: OperationalTimelineEvent): number {
    return compareDatesAsc(left.timestamp, right.timestamp);
}
