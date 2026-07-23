
import type { GovernanceApprovalInput, GovernanceBundle, GovernanceCapacityConstraint, GovernanceContextInput, GovernanceDecisionOption, GovernanceEvent, GovernancePolicyItem, GovernanceProjection, GovernanceReviewItem, GovernanceTone } from '../governance-projection.js';
import { safeArray, compact, latestDate, anchorPart, titleFromKind, describeState, toneForSeverity, toneForState } from './index.js';

export function approvalLookupKeys(value: unknown): Set<string> {
    const raw = compact(value, '');
    const decoded = decodeValue(raw);
    const values = new Set<string>();
    for (const candidate of [raw, decoded]) {
        if (!candidate)
            continue;
        values.add(candidate);
        values.add(candidate.replace(/^approval-/u, ''));
        values.add(candidate.replace(/^approval:/u, ''));
        values.add(candidate.replace(/^approval[-:]/u, 'approval:'));
        values.add(candidate.replace(/^approval[-:]/u, 'approval-'));
    }
    return values;
}

export function decodeValue(value: string): string {
    let decoded = value;
    for (let index = 0; index < 2; index += 1) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded)
                break;
            decoded = next;
        }
        catch {
            break;
        }
    }
    return decoded;
}

export async function loadGovernanceBundles(input: GovernanceContextInput): Promise<GovernanceBundle[]> {
    const store = input.store;
    if (!store)
        return [];
    const teams = safeArray(input.teams);
    const activeTeam = teams[0] ?? null;
    const inboxItems = activeTeam && typeof store.listPersistedTeamInboxItems === 'function'
        ? await store.listPersistedTeamInboxItems(activeTeam.id).catch(() => [])
        : [];
    const teamApprovals = activeTeam && typeof store.listApprovalRequestsForTeam === 'function'
        ? await store.listApprovalRequestsForTeam(activeTeam.id, { limit: 200 }).catch(() => [])
        : [];
    const teamAuditEvents = activeTeam && typeof store.listAuditEventsForTarget === 'function'
        ? await store.listAuditEventsForTarget('team', activeTeam.id, 100).catch(() => [])
        : [];
    const projects = safeArray(input.projects);
    const projectBundles = await Promise.all(projects.map(async (project: any) => {
        const [summary, agents, approvals, capacityOperations, workdays, auditEvents] = await Promise.all([
            typeof store.getProjectSummary === 'function' ? store.getProjectSummary(project.id, input.principal).catch(() => null) : null,
            typeof store.getProjectAgentsSummary === 'function' ? store.getProjectAgentsSummary(project.id, input.principal).catch(() => null) : null,
            typeof store.listApprovalRequestsForProject === 'function' ? store.listApprovalRequestsForProject(project.id, 200).catch(() => []) : [],
            typeof store.getProjectCapacityOperations === 'function' ? store.getProjectCapacityOperations(project.id, 'staging').catch(() => null) : null,
            typeof store.listWorkdayCapacityEnvelopes === 'function' ? store.listWorkdayCapacityEnvelopes(project.id) : [],
            typeof store.listAuditEventsForTarget === 'function' ? store.listAuditEventsForTarget('project', project.id, 100).catch(() => []) : [],
        ]);
        return {
            project,
            summary,
            agents,
            approvals: safeArray(approvals),
            capacityOperations,
            workdays: safeArray(workdays),
            inboxItems: safeArray(inboxItems).filter((item: any) => !item.projectId || item.projectId === project.id),
            auditEvents: safeArray(auditEvents),
        };
    }));
    const teamOnlyApprovals = safeArray(teamApprovals).filter((approval: any) => !projects.some((project: any) => project.id === approval.projectId));
    const teamBundle = activeTeam ? [{
            project: null,
            summary: null,
            agents: null,
            approvals: teamOnlyApprovals,
            capacityOperations: null,
            workdays: [],
            inboxItems: safeArray(inboxItems).filter((item: any) => !item.projectId),
            auditEvents: safeArray(teamAuditEvents),
        }] : [];
    return [...projectBundles, ...teamBundle];
}

export function approvalItem(bundle: GovernanceBundle, approval: any): GovernanceReviewItem {
    const id = compact(approval?.id, 'approval');
    const severity = compact(approval?.severity, 'moderate');
    const state = compact(approval?.state, 'pending');
    return {
        id: `approval-${id}`,
        approvalId: id,
        projectId: compact(approval?.projectId, compact(bundle.project?.id, '')) || null,
        projectName: compact(bundle.project?.name, compact(bundle.project?.slug, 'Organization')),
        workDayId: compact(approval?.workDayId, compact(approval?.work_day_id, '')) || null,
        taskId: compact(approval?.taskId, compact(approval?.task_id, '')) || null,
        kind: compact(approval?.kind, 'approval'),
        severity,
        title: compact(approval?.title, 'Approval requested'),
        description: compact(approval?.summary, titleFromKind(approval?.kind, 'Operational review')),
        category: 'governance',
        phase: 'governance',
        state,
        tone: toneForSeverity(severity, state),
        timestamp: latestDate(approval?.createdAt, approval?.updatedAt, approval?.decidedAt),
        requestedAt: latestDate(approval?.createdAt),
        expiresAt: latestDate(approval?.expiresAt),
        href: `/app/work/decisions/${encodeURIComponent(id)}`,
        meta: `${describeState(severity, 'moderate')} severity`,
        governanceRefs: [id],
        decisionOptions: decisionOptionsFor(approval),
        policySnapshot: objectValue(approval?.policySnapshot) ?? {},
        recommendation: objectValue(approval?.recommendation) ?? {},
        metadata: objectValue(approval?.metadata) ?? {},
    };
}

export function policyItemsForBundle(bundle: GovernanceBundle): GovernancePolicyItem[] {
    const capabilityPolicies = safeArray(bundle.summary?.capabilityGrants)
        .filter((grant: any) => grant?.approvalPolicy?.requiresApproval)
        .map((grant: any) => ({
        id: `policy-${grant.id ?? grant.namespace ?? 'capability'}-${grant.operation ?? 'approval'}`,
        title: compact(grant?.label, `${compact(grant?.namespace, 'operation')}.${compact(grant?.operation, 'approval')}`),
        description: compact(grant?.approvalPolicy?.reason, 'Human approval required before execution.'),
        category: 'governance' as const,
        phase: 'governance' as const,
        state: grant.enabled === false ? 'paused' : 'active',
        tone: grant.enabled === false ? 'warning' as const : 'success' as const,
        href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/settings` : '/app/work/decisions',
        meta: compact(bundle.project?.name, 'policy'),
        projectId: compact(bundle.project?.id, '') || null,
        projectName: compact(bundle.project?.name, ''),
        policyType: 'approval',
        constraints: objectValue(grant?.approvalPolicy) ?? {},
    }));
    const allocationSet = bundle.capacityOperations?.summary?.allocationSet;
    const allocationPolicyItem = allocationSet ? [{
            id: `policy-capacity-allocation-${allocationSet.id}`,
            title: `${compact(bundle.project?.name, 'Project')} capacity allocation`,
            description: 'The active team allocation set governs project shares, reserves, borrowing, and admission limits.',
            category: 'governance' as const,
            phase: 'governance' as const,
            state: compact(allocationSet.status, 'active'),
            tone: toneForState(allocationSet.status),
            href: bundle.project?.id ? `/app/projects/${encodeURIComponent(bundle.project.id)}/guidance` : '/app/work/decisions',
            meta: `allocation v${Number(allocationSet.version ?? 0)}`,
            projectId: compact(bundle.project?.id, '') || null,
            projectName: compact(bundle.project?.name, ''),
            policyType: 'capacity-allocation',
            constraints: {
                reservePolicy: allocationSet.reservePolicy,
                slices: safeArray(allocationSet.slices),
                borrowingRules: safeArray(allocationSet.borrowingRules),
                effectiveFrom: allocationSet.effectiveFrom,
                effectiveUntil: allocationSet.effectiveUntil,
            },
        }] : [];
    return [...capabilityPolicies, ...allocationPolicyItem];
}

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

export function decisionOptionsFor(approval: any): GovernanceDecisionOption[] {
    const rawOptions = safeArray(approval?.options)
        .filter((option: any) => option && typeof option === 'object')
        .map((option: any) => {
        const id = compact(option.id, compact(option.value, compact(option.decision, '')));
        if (!id)
            return null;
        return {
            id,
            label: compact(option.label, titleFromKind(id)),
            state: decisionState(id),
            tone: decisionState(id) === 'rejected' ? 'danger' as const : 'success' as const,
        };
    })
        .filter(Boolean) as GovernanceDecisionOption[];
    if (rawOptions.length > 0)
        return rawOptions;
    return [
        { id: 'approve', label: 'Approve', state: 'approved', tone: 'success' },
        { id: 'reject', label: 'Reject', state: 'rejected', tone: 'danger' },
    ];
}

export function decisionState(id: string): 'approved' | 'rejected' {
    const value = id.toLowerCase();
    return value.includes('reject') || value.includes('revision') || value.includes('changes') || value.includes('pause') ? 'rejected' : 'approved';
}

export function uniqueApprovals(approvals: any[]) {
    const byId = new Map<string, any>();
    for (const approval of approvals) {
        const id = compact(approval?.id);
        if (id && !byId.has(id))
            byId.set(id, approval);
    }
    return [...byId.values()];
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
