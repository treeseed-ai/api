import { approvalLookupKeys, decodeValue, loadGovernanceBundles, approvalItem, policyItemsForBundle, capacityConstraintsForBundle, activityEventsForBundle, auditEventsForBundle, decisionOptionsFor, decisionState, uniqueApprovals, compareEventDesc, workdayRef, objectValue, safeArray, compact, latestDate, anchorPart, titleFromKind, describeState, toneForSeverity, toneForState } from "./governance-projection-support/index.js";
export type GovernanceTone = 'default' | 'muted' | 'info' | 'success' | 'warning' | 'danger' | 'accent';
export interface GovernanceMetric {
    label: string;
    value: string | number;
    description?: string;
    tone?: GovernanceTone;
}
export interface GovernanceEvent {
    id: string;
    title: string;
    description?: string;
    category: 'governance';
    phase: 'governance';
    state?: string;
    tone?: GovernanceTone;
    timestamp?: string | null;
    href?: string;
    meta?: string;
    governanceRefs?: string[];
}
export interface GovernanceReviewItem extends GovernanceEvent {
    approvalId: string;
    projectId?: string | null;
    projectName?: string;
    workDayId?: string | null;
    taskId?: string | null;
    kind: string;
    severity: string;
    requestedAt?: string | null;
    expiresAt?: string | null;
    decisionOptions: GovernanceDecisionOption[];
    policySnapshot?: Record<string, unknown>;
    recommendation?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
export interface GovernanceDecisionOption {
    id: string;
    label: string;
    state: 'approved' | 'rejected';
    tone: GovernanceTone;
}
export interface GovernancePolicyItem extends GovernanceEvent {
    projectId?: string | null;
    projectName?: string;
    policyType: string;
    constraints?: Record<string, unknown>;
}
export interface GovernanceCapacityConstraint extends GovernanceEvent {
    projectId?: string | null;
    projectName?: string;
    constraintType: string;
}
export interface GovernanceProjection {
    metrics: GovernanceMetric[];
    pendingApprovals: GovernanceReviewItem[];
    escalations: GovernanceReviewItem[];
    reviewQueue: GovernanceReviewItem[];
    reviewTimeline: GovernanceEvent[];
    auditTrail: GovernanceEvent[];
    policies: GovernancePolicyItem[];
    policyViolations: GovernanceCapacityConstraint[];
    capacityConstraints: GovernanceCapacityConstraint[];
}
export interface GovernanceApprovalProjection {
    approval: GovernanceReviewItem;
    relatedWorkday: any | null;
    relatedProject: any | null;
    repositories: any[];
    relatedArtifacts: any[];
    policies: GovernancePolicyItem[];
    capacityConstraints: GovernanceCapacityConstraint[];
    auditTrail: GovernanceEvent[];
    decisionOptions: GovernanceDecisionOption[];
}
export interface GovernanceContextInput {
    store: any;
    principal?: any;
    teams?: any[];
    projects?: any[];
}
export interface GovernanceApprovalInput extends GovernanceContextInput {
    approvalId: string;
}
export interface GovernanceBundle {
    project: any | null;
    summary: any | null;
    agents: any | null;
    approvals: any[];
    capacityOperations: any | null;
    workdays: any[];
    inboxItems: any[];
    auditEvents: any[];
}
export async function buildGovernanceProjection(input: GovernanceContextInput): Promise<GovernanceProjection> {
    const bundles = await loadGovernanceBundles(input);
    const approvals = uniqueApprovals(bundles.flatMap((bundle) => bundle.approvals.map((approval) => ({ ...approval, __bundle: bundle }))));
    const reviewQueue = approvals.map((approval) => approvalItem(approval.__bundle, approval));
    const pendingApprovals = reviewQueue.filter((item) => ['pending', 'waiting_for_approval', 'under_review'].includes(item.state ?? ''));
    const escalations = reviewQueue.filter((item) => ['high', 'critical'].includes(item.severity.toLowerCase())
        || ['escalated', 'blocked'].includes(String(item.state ?? '').toLowerCase()));
    const policies = bundles.flatMap(policyItemsForBundle);
    const capacityConstraints = bundles.flatMap(capacityConstraintsForBundle);
    const policyViolations = capacityConstraints.filter((item) => ['blocked', 'approval_required', 'paused_by_policy', 'waiting_for_budget'].includes(String(item.state ?? '').toLowerCase()));
    const activityEvents = bundles.flatMap(activityEventsForBundle);
    const reviewTimeline = [...reviewQueue, ...activityEvents].sort(compareEventDesc);
    const auditTrail = [
        ...reviewTimeline,
        ...bundles.flatMap((bundle) => auditEventsForBundle(bundle)),
        ...capacityConstraints,
    ].sort(compareEventDesc).slice(0, 60);
    return {
        metrics: [
            { label: 'Pending approvals', value: pendingApprovals.length, tone: pendingApprovals.length ? 'warning' : 'success' },
            { label: 'Escalations', value: escalations.length, tone: escalations.length ? 'danger' : 'success' },
            { label: 'Policies visible', value: policies.length },
            { label: 'Audit events', value: auditTrail.length },
            { label: 'Capacity constraints', value: capacityConstraints.length, tone: capacityConstraints.length ? 'warning' : 'success' },
        ],
        pendingApprovals,
        escalations,
        reviewQueue,
        reviewTimeline,
        auditTrail,
        policies,
        policyViolations,
        capacityConstraints,
    };
}
export async function buildGovernanceApprovalProjection(input: GovernanceApprovalInput): Promise<GovernanceApprovalProjection | null> {
    const bundles = await loadGovernanceBundles(input);
    const approvals = uniqueApprovals(bundles.flatMap((bundle) => bundle.approvals.map((approval) => ({ ...approval, __bundle: bundle }))));
    const inputApprovalIds = approvalLookupKeys(input.approvalId);
    const match = approvals.find((approval) => {
        const keys = approvalLookupKeys(approval.id);
        return [...inputApprovalIds].some((key) => keys.has(key));
    });
    if (!match)
        return null;
    const bundle = match.__bundle as GovernanceBundle;
    const approval = approvalItem(bundle, match);
    const relatedWorkday = safeArray(bundle.workdays).find((workday: any) => workdayRef(workday) === approval.workDayId || compact(workday?.id) === approval.workDayId) ?? null;
    const relatedArtifacts = [
        ...safeArray(bundle.agents?.generatedArtifacts),
        ...safeArray(bundle.agents?.knowledgeDrafts).map((entry: any) => entry?.knowledgeDraft ?? entry),
        ...safeArray(bundle.agents?.runtimeReports),
    ].filter((artifact: any) => !approval.workDayId || workdayRef(artifact) === approval.workDayId);
    const policies = policyItemsForBundle(bundle).filter((policy) => !approval.projectId || policy.projectId === approval.projectId);
    const capacityConstraints = capacityConstraintsForBundle(bundle).filter((constraint) => !approval.workDayId || !constraint.governanceRefs?.length || constraint.governanceRefs.includes(approval.approvalId));
    const auditTrail = [
        approval,
        ...activityEventsForBundle(bundle),
        ...auditEventsForBundle(bundle),
        ...capacityConstraints,
    ].sort(compareEventDesc);
    return {
        approval,
        relatedWorkday,
        relatedProject: bundle.project,
        repositories: safeArray(bundle.summary?.repositories),
        relatedArtifacts: relatedArtifacts.map((artifact: any) => ({
            id: compact(artifact?.id, compact(artifact?.draftId, compact(artifact?.reportId, 'artifact'))),
            title: compact(artifact?.title, compact(artifact?.name, 'Operational artifact')),
            state: compact(artifact?.state, compact(artifact?.reviewState, 'generated')),
            href: `/app/knowledge/operations/${anchorPart(artifact?.id ?? artifact?.draftId ?? artifact?.reportId).toLowerCase()}`,
        })),
        policies,
        capacityConstraints,
        auditTrail,
        decisionOptions: approval.decisionOptions,
    };
}
