import { type GovernanceBundle, type GovernanceDecisionOption, type GovernanceReviewItem } from '../governance-projection.js';
import { safeArray, compact, latestDate, titleFromKind, describeState, toneForSeverity, objectValue } from './index.js';

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
