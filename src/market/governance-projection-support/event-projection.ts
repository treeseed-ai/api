import { type GovernanceBundle, type GovernanceEvent } from '../projects/projects-core/governance-projection.js';
import { safeArray, compact, latestDate, titleFromKind, describeState, toneForState } from './index.js';

export function activityEventsForBundle(bundle: GovernanceBundle): GovernanceEvent[] {
    const activity = safeArray(bundle.summary?.recentActivity).map((entry: any) => ({
        id: `activity-${entry.id ?? entry.timestamp ?? entry.title}`,
        title: compact(entry?.title, `${compact(bundle.project?.name, 'Project')} activity`),
        description: compact(entry?.summary, describeState(entry?.status, 'recorded')),
        category: 'governance' as const,
        phase: 'governance' as const,
        state: compact(entry?.status, 'recorded'),
        tone: toneForState(entry?.status),
        timestamp: latestDate(entry?.timestamp, entry?.createdAt),
        href: compact(entry?.href, bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/settings` : '/app/work/decisions')
            .replace(`/app/${'governance'}`, '/app/work/decisions')
            .replace(`/app/${'decisions'}`, '/app/work/decisions')
            .replace(`/app/${'workdays'}`, '/app/projects'),
        meta: compact(bundle.project?.name, 'activity'),
    }));
    const inbox = safeArray(bundle.inboxItems).map((item: any) => ({
        id: `inbox-${item.id}`,
        title: compact(item?.title, 'Governance inbox item'),
        description: compact(item?.summary, describeState(item?.kind, 'review item')),
        category: 'governance' as const,
        phase: 'governance' as const,
        state: compact(item?.state, 'recorded'),
        tone: toneForState(item?.state),
        timestamp: latestDate(item?.createdAt, item?.updatedAt),
        href: item?.itemKey ? `/app/work/decisions/${encodeURIComponent(item.itemKey)}` : compact(item?.href, '/app/work/decisions').replace(`/app/${'governance'}`, '/app/work/decisions').replace(`/app/${'decisions'}`, '/app/work/decisions'),
        meta: compact(item?.kind, 'inbox'),
    }));
    return [...activity, ...inbox];
}

export function auditEventsForBundle(bundle: GovernanceBundle): GovernanceEvent[] {
    return safeArray(bundle.auditEvents).map((event: any) => ({
        id: `audit-${event.id}`,
        title: titleFromKind(event.eventType ?? event.event_type, 'Audit event'),
        description: compact(event.data?.summary, describeState(event.targetType ?? event.target_type, 'audit record')),
        category: 'governance' as const,
        phase: 'governance' as const,
        state: 'recorded',
        tone: 'muted' as const,
        timestamp: latestDate(event.createdAt ?? event.created_at),
        href: '/app/work/decisions',
        meta: compact(event.actorType ?? event.actor_type, 'audit'),
    }));
}

export function compareEventDesc(left: GovernanceEvent, right: GovernanceEvent) {
    return Date.parse(right.timestamp ?? '') - Date.parse(left.timestamp ?? '');
}

export function workdayRef(value: any) {
    return compact(value?.workDayId, compact(value?.work_day_id, ''));
}

export function objectValue(value: any) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
