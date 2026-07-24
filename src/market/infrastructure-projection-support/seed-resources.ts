import { anchorPart, compact, describeState, safeArray, toneForState } from '../operational-artifacts.js';
import { type InfrastructureItem } from '../infrastructure-projection.js';
import { latestDate, seedSummary } from './index.js';

export function seedItems(seedState: any): InfrastructureItem[] {
    if (!seedState)
        return [];
    return [
        {
            id: 'seed-plan',
            title: `Seed ${compact(seedState.selectedSeed, 'treeseed')}`,
            description: seedState.error ?? seedSummary(seedState.plan),
            category: 'infrastructure',
            state: seedState.error ? 'blocked' : safeArray(seedState.diagnostics).some((diagnostic: any) => diagnostic.severity === 'error') ? 'needs_review' : 'planned',
            tone: seedState.error ? 'danger' : safeArray(seedState.diagnostics).length ? 'warning' : 'success',
            href: '/app#seed-plan',
            meta: compact(seedState.selectedEnvironments, 'environment'),
        },
        ...safeArray(seedState.runs).map((run: any) => ({
            id: `seed-run-${anchorPart(run?.id ?? run?.manifestHash)}`,
            title: `Seed run ${compact(run?.id, compact(run?.manifestHash, 'record'))}`,
            description: describeState(run?.status ?? run?.state, 'recorded'),
            category: 'infrastructure' as const,
            state: compact(run?.status, compact(run?.state, 'recorded')),
            tone: toneForState(run?.status ?? run?.state),
            timestamp: latestDate(run?.updatedAt, run?.createdAt),
            href: `/app#seed-run-${anchorPart(run?.id ?? run?.manifestHash)}`,
            meta: 'seed run',
        })),
        ...safeArray(seedState.approvals).map((approval: any) => ({
            id: `seed-approval-${anchorPart(approval?.id)}`,
            title: compact(approval?.title, 'Seed approval'),
            description: compact(approval?.summary, 'Approval required for seed operation.'),
            category: 'governance' as const,
            state: compact(approval?.state, 'pending'),
            tone: toneForState(approval?.state ?? approval?.severity),
            timestamp: latestDate(approval?.createdAt, approval?.updatedAt),
            href: approval?.id ? `/app/work/decisions/${encodeURIComponent(approval.id)}` : '/app/work/decisions',
            meta: describeState(approval?.severity, 'review'),
        })),
    ];
}
