import { authorizeHostedTopologyPlan, authorizeHostedTopologyRollbackExecution, deploymentDigest, hostedTopologyPlanSchema, hostedTopologyReceiptSchema, hostedTopologyRollbackExecutionSchema, verifyHostedTopologyReadback, type AuthorizedHostedTopologyPlan, type HostedResourceObservation } from '@treeseed/sdk/deployment';

export interface HostedTopologyExecutionAdapter {
	apply(input: { teamId: string; plan: AuthorizedHostedTopologyPlan; approval: unknown }): Promise<HostedResourceObservation[]>;
	rollback(input: { teamId: string; execution: ReturnType<typeof hostedTopologyRollbackExecutionSchema.parse>; approval: unknown; sourceReceipt: unknown; sourcePlan: unknown; targetPlan: unknown }): Promise<HostedResourceObservation[]>;
}

async function latestReceipt(store: any, teamId: string, topologyId?: string) {
	const row = await store.first(`SELECT payload_json FROM runtime_records WHERE record_type = 'hosted_topology_receipt' AND lookup_key = ?
		${topologyId ? 'AND secondary_key = ?' : ''} ORDER BY updated_at DESC LIMIT 1`, topologyId ? [teamId, topologyId] : [teamId]);
	return row ? hostedTopologyReceiptSchema.parse(JSON.parse(row.payload_json)) : null;
}

async function persistReceipt(store: any, teamId: string, receipt: ReturnType<typeof hostedTopologyReceiptSchema.parse>) {
	const now = new Date().toISOString();
	await store.run(`INSERT INTO runtime_records (record_type, record_key, lookup_key, secondary_key, status, schema_version, created_at, updated_at, payload_json, meta_json)
		VALUES ('hosted_topology_receipt', ?, ?, ?, 'known-good', 1, ?, ?, ?, '{}')`,
	[receipt.receiptId, teamId, receipt.topologyId, now, now, JSON.stringify(receipt)]);
}

function missingPrevious(plan: ReturnType<typeof hostedTopologyPlanSchema.parse>, completedAt: string): HostedResourceObservation[] {
	return plan.actions.map((action) => ({ resourceId: action.resourceId, provider: action.provider, kind: action.kind, providerResourceId: action.providerResourceId,
		state: action.previousDigest ? 'healthy' : 'missing', managedBy: action.previousDigest ? 'treeseed' : null, observedDigest: action.previousDigest, observedAt: completedAt }));
}

export function createHostedTopologyExecutors(options: { controlPlaneStore?: any; hostedTopologyAdapter?: HostedTopologyExecutionAdapter }) {
	const unavailable: HostedTopologyExecutionAdapter = {
		async apply() { throw new Error('Hosted topology execution adapter is not configured.'); },
		async rollback() { throw new Error('Hosted topology execution adapter is not configured.'); },
	};
	const adapter = options.hostedTopologyAdapter ?? unavailable, store = options.controlPlaneStore;
	const apply = { namespace: 'infrastructure', operation: 'hosted-topology-apply', async run(input: Record<string, unknown>, context: any) {
		if (!store) throw new Error('Hosted topology execution requires the control-plane store.');
		const teamId = String(input.teamId ?? ''), plan = hostedTopologyPlanSchema.parse(input.plan);
		const authorized = authorizeHostedTopologyPlan(plan, input.approval as any), completedAt = new Date().toISOString();
		await context.checkpoint({ phase: 'provider-apply', planDigest: plan.planDigest }, { kind: 'infrastructure.topology.apply.started', data: { teamId, planDigest: plan.planDigest } });
		const resources = await adapter.apply({ teamId, plan: authorized, approval: input.approval });
		const previous = await latestReceipt(store, teamId, plan.topologyId);
		const receipt = verifyHostedTopologyReadback({ plan: authorized, previousResources: previous?.resources ?? missingPrevious(plan, completedAt), resources, completedAt });
		await persistReceipt(store, teamId, receipt);
		await context.checkpoint({ phase: 'read-back', receiptId: receipt.receiptId }, { kind: 'infrastructure.topology.known-good', data: { teamId, receiptId: receipt.receiptId } });
		return { receipt };
	} };
	const rollback = { namespace: 'infrastructure', operation: 'hosted-topology-rollback', async run(input: Record<string, unknown>, context: any) {
		if (!store) throw new Error('Hosted topology rollback requires the control-plane store.');
		const teamId = String(input.teamId ?? ''), execution = hostedTopologyRollbackExecutionSchema.parse(input.execution);
		authorizeHostedTopologyRollbackExecution(execution, input.approval as any);
		const plan = execution.rollback;
		const source = await latestReceipt(store, teamId); if (!source || source.receiptId !== plan.sourceReceiptId) throw new Error('Hosted topology rollback source is stale.');
		await context.checkpoint({ phase: 'provider-rollback', rollbackDigest: plan.rollbackDigest }, { kind: 'infrastructure.topology.rollback.started', data: { teamId, rollbackDigest: plan.rollbackDigest } });
		const resources = await adapter.rollback({ teamId, execution, approval: input.approval, sourceReceipt: source, sourcePlan: input.sourcePlan, targetPlan: input.targetPlan }), completedAt = new Date().toISOString();
		const receiptDigest = deploymentDigest({ sourceReceiptId: source.receiptId, resources, completedAt });
		const receipt = hostedTopologyReceiptSchema.parse({ ...source, receiptId: `topology-receipt-${receiptDigest.slice(7, 23)}`, resources, previousResources: source.resources, completedAt });
		await persistReceipt(store, teamId, receipt);
		return { receipt, rolledBackFrom: source.receiptId };
	} };
	return [apply, rollback];
}
