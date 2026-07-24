import { anchorPart, compact, describeState, safeArray, toneForState } from '../operations/operational-artifacts.js';
import { type InfrastructureBundle, type InfrastructureItem } from '../projects/hosting/infrastructure-projection.js';
import { projectName } from './index.js';

export function productItem(product: any): InfrastructureItem {
    const id = compact(product?.id, compact(product?.slug, compact(product?.title, 'resource')));
    return {
        id: `resource-${anchorPart(id)}`,
        title: compact(product?.title, compact(product?.name, compact(product?.slug, 'Operational resource'))),
        description: compact(product?.summary, describeState(product?.kind, 'Reusable operational asset')),
        category: 'knowledge',
        state: compact(product?.visibility, compact(product?.status, 'available')),
        tone: toneForState(product?.visibility === 'public' ? 'active' : product?.status),
        href: `/app/knowledge/artifacts#resource-${anchorPart(id)}`,
        meta: compact(product?.kind, 'resource'),
    };
}

export function policyItems(bundle: InfrastructureBundle): InfrastructureItem[] {
    return [
        ...safeArray(bundle.summary?.capabilityGrants).map((grant: any) => ({
            id: `policy-${anchorPart(grant?.id ?? grant?.operation)}`,
            title: compact(grant?.label, `${compact(grant?.namespace, 'operation')}.${compact(grant?.operation, 'policy')}`),
            description: compact(grant?.approvalPolicy?.reason, describeState(grant?.defaultDispatchMode, 'operational policy')),
            category: 'governance' as const,
            state: grant?.enabled === false ? 'paused' : 'active',
            tone: grant?.enabled === false ? 'warning' as const : 'success' as const,
            href: `/app/work/decisions#policy-${anchorPart(grant?.id ?? grant?.operation)}`,
            meta: projectName(bundle),
            projectId: compact(bundle.project?.id, '') || null,
            projectName: projectName(bundle),
        })),
        ...(bundle.capacityOperations?.summary?.workPolicy ? [{
                id: `policy-work-${anchorPart(bundle.project?.id)}`,
                title: `${projectName(bundle)} work policy`,
                description: describeState(bundle.capacityOperations.summary.workPolicy.enabled === false ? 'paused' : 'active', 'work policy'),
                category: 'governance' as const,
                state: bundle.capacityOperations.summary.workPolicy.enabled === false ? 'paused' : 'active',
                tone: bundle.capacityOperations.summary.workPolicy.enabled === false ? 'warning' as const : 'success' as const,
                href: `/app/work/decisions#policy-work-${anchorPart(bundle.project?.id)}`,
                meta: compact(bundle.capacityOperations.summary.workPolicy.environment, 'staging'),
                projectId: compact(bundle.project?.id, '') || null,
                projectName: projectName(bundle),
            }] : []),
    ];
}
