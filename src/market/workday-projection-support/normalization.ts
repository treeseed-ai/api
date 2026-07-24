import { compact, latestDate, toneForState } from '../operations/operational-artifacts.js';

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
