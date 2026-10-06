import { actorId,actorType,stableJson } from '../index.js';
import type { ControlPlaneStore } from '../../../../api/persistence/store.ts';
import type { SeedPlanSummary } from '../../contracts/types.ts';

export function planApprovalMetadata(plan: { seed: unknown; version: unknown; environments: readonly unknown[]; summary: SeedPlanSummary }, manifestHash: unknown) {
	return { seed: { name: plan.seed, version: plan.version, environments: plan.environments, manifestHash, planSummary: plan.summary } };
}

export function approvalMatchesPlan(approval: { state?: unknown; metadata?: { seed?: { name?: unknown; version?: unknown; manifestHash?: unknown; environments?: unknown; planSummary?: unknown } } } | null | undefined, plan: Parameters<typeof planApprovalMetadata>[0], manifestHash: unknown) {
	const seed = approval?.metadata?.seed;
	return Boolean(approval
		&& approval.state === 'approved'
		&& seed?.name === plan.seed
		&& seed?.version === plan.version
		&& seed?.manifestHash === manifestHash
		&& stableJson(seed?.environments ?? []) === stableJson(plan.environments)
		&& stableJson(seed?.planSummary ?? {}) === stableJson(plan.summary));
}

export function findApprovalAnchor(plan: { actions: readonly {
    kind: unknown; key: unknown; payload: Record<string, unknown> & { teamKey?: unknown; slug?: unknown };
    existing?: { id?: string; slug?: unknown } | null;
}[] }) {
	const project = plan.actions.find((action) => action.kind === 'project' && action.existing?.id);
	if (!project?.existing?.id) return null;
	const teamAction = plan.actions.find((action) => action.key === project.payload.teamKey);
	if (!teamAction?.existing?.id) return null;
	return {
		projectId: project.existing.id,
		projectSlug: project.existing.slug ?? project.payload.slug,
		teamId: teamAction.existing.id,
		teamSlug: teamAction.existing.slug ?? teamAction.payload.slug,
	};
}

export async function createProductionApproval({ store, plan, manifestHash, actor }: {
    store: Pick<ControlPlaneStore, 'createApprovalRequest' | 'upsertTeamInboxItem'>;
    plan: Parameters<typeof findApprovalAnchor>[0] & Parameters<typeof planApprovalMetadata>[0];
    manifestHash: unknown; actor?: Parameters<typeof actorId>[0] & Parameters<typeof actorType>[0];
}) {
	const anchor = findApprovalAnchor(plan);
	if (!anchor) return { ok: false, message: 'Production seed apply requires an existing project approval anchor.' };
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
		options: [{ id: 'approve', label: 'Approve production seed apply' }, { id: 'reject', label: 'Reject production seed apply' }],
		recommendation: { optionId: 'approve' },
		policySnapshot: { policy: 'seed.production.apply.requires_approval', environments: plan.environments },
		metadata,
	});
	if (!request) return { ok: false, message: 'Production seed approval request could not be read back.' };
	await store.upsertTeamInboxItem(anchor.teamId, {
		id: `seed-approval:${request.id}`,
		projectId: anchor.projectId,
		kind: 'approval',
		state: 'waiting_for_approval',
		title: request.title,
		summary: request.summary,
		href: `/app/work/decisions#approval-${request.id}`,
		itemKey: request.id,
		metadata: { approvalId: request.id, approvalRequestId: request.id, approvalKind: request.kind, seed: metadata.seed },
	});
	return { ok: true, approvalRequest: request };
}

export function redactSeedApplyResult<T>(result: T): T {
	return result;
}
