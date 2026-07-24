import { stableJson, actorId, actorType } from '../../index.js';

export function planApprovalMetadata(plan, manifestHash) {
    return {
        seed: {
            name: plan.seed,
            version: plan.version,
            environments: plan.environments,
            manifestHash,
            planSummary: plan.summary,
        },
    };
}

export function approvalMatchesPlan(approval, plan, manifestHash) {
    const seed = approval?.metadata?.seed;
    return Boolean(approval
        && approval.state === 'approved'
        && seed?.name === plan.seed
        && seed?.version === plan.version
        && seed?.manifestHash === manifestHash
        && stableJson(seed?.environments ?? []) === stableJson(plan.environments)
        && stableJson(seed?.planSummary ?? {}) === stableJson(plan.summary));
}

export function findApprovalAnchor(plan) {
    const preferred = plan.actions.find((action) => action.kind === 'project' && action.key === 'project:treeseed/market' && action.existing?.id);
    const project = preferred ?? plan.actions.find((action) => action.kind === 'project' && action.existing?.id);
    if (!project)
        return null;
    const teamAction = plan.actions.find((action) => action.key === project.payload.teamKey);
    if (!teamAction?.existing?.id)
        return null;
    return {
        projectId: project.existing.id,
        projectSlug: project.existing.slug ?? project.payload.slug,
        teamId: teamAction.existing.id,
        teamSlug: teamAction.existing.slug ?? teamAction.payload.slug,
    };
}

export async function createProductionApproval({ store, plan, manifestHash, actor }) {
    const anchor = findApprovalAnchor(plan);
    if (!anchor) {
        return {
            ok: false,
            message: 'Production seed apply requires an existing seeded project approval anchor. Apply or plan staging first so the seeded market project exists.',
        };
    }
    const metadata = planApprovalMetadata(plan, manifestHash);
    const request = await store.createApprovalRequest({
        teamId: anchor.teamId,
        projectId: anchor.projectId,
        kind: 'seed_production_apply',
        severity: 'high',
        requestedByType: actorType(actor) === 'service' ? 'service' : actorType(actor) === 'agent' ? 'agent' : 'user',
        requestedById: actorId(actor),
        title: `Approve production seed apply: ${plan.seed}`,
        summary: `Apply seed ${plan.seed} to production. Planned changes: create ${plan.summary.create}, update ${plan.summary.update}, unchanged ${plan.summary.unchanged}.`,
        options: [
            { id: 'approve', label: 'Approve production seed apply' },
            { id: 'reject', label: 'Reject production seed apply' },
        ],
        recommendation: { optionId: 'approve' },
        policySnapshot: {
            policy: 'seed.production.apply.requires_approval',
            environments: plan.environments,
        },
        metadata,
    });
    await store.upsertTeamInboxItem(anchor.teamId, {
        id: `seed-approval:${request.id}`,
        projectId: anchor.projectId,
        kind: 'approval',
        state: 'waiting_for_approval',
        title: request.title,
        summary: request.summary,
        href: `/app/work/decisions#approval-${request.id}`,
        itemKey: request.id,
        metadata: {
            approvalId: request.id,
            approvalRequestId: request.id,
            approvalKind: request.kind,
            seed: metadata.seed,
        },
    });
    return { ok: true, approvalRequest: request };
}

export function redactSeedApplyResult(result) {
    return result;
}
