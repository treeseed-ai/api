import { type GovernanceBundle, type GovernancePolicyItem } from '../governance-projection.js';
import { safeArray, compact, toneForState, objectValue } from './index.js';

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
