import {
	authorizeHostedTopologyPlan, authorizeHostedTopologyRollbackExecution, deploymentDigest, hostedStateBackendSchema,
	hostedTopologyDeclarationSchema, hostedTopologyPlanSchema, hostedTopologyReceiptSchema, hostedTopologyRollbackExecutionSchema,
	planHostedTopology, verifyHostedTopologyReadback, type AuthorizedHostedTopologyPlan, type HostedResourceObservation,
	type HostedStateBackend, type HostedTopologyDeclaration,
} from '@treeseed/sdk/deployment';
import { createDeploymentHostedAdapter } from './deployment-hosted-adapter.ts';

export interface HostedTopologyExecutionAdapter {
	observe(input: { teamId: string; declaration: HostedTopologyDeclaration; stateBackend: HostedStateBackend;
		connections: Record<string, Record<string, unknown>> }): Promise<HostedResourceObservation[]>;
	apply(input: { teamId: string; plan: AuthorizedHostedTopologyPlan }): Promise<HostedResourceObservation[]>;
	rollback(input: { teamId: string; execution: ReturnType<typeof hostedTopologyRollbackExecutionSchema.parse>;
		sourceReceipt: unknown; sourcePlan: unknown; targetPlan: unknown }): Promise<HostedResourceObservation[]>;
}

async function latestReceipt(store: any, teamId: string, topologyId?: string) {
	const row = await store.first(`SELECT payload_json FROM runtime_records WHERE record_type = 'hosted_topology_receipt' AND lookup_key = ?
		${topologyId ? 'AND secondary_key = ?' : ''} ORDER BY updated_at DESC LIMIT 1`, topologyId ? [teamId, topologyId] : [teamId]);
	return row ? hostedTopologyReceiptSchema.parse(JSON.parse(row.payload_json)) : null;
}

async function persistRecord(store: any, type: 'hosted_topology_plan' | 'hosted_topology_receipt', teamId: string,
	key: string, topologyId: string, payload: unknown, status: string) {
	const now = new Date().toISOString();
	const existing = await store.first('SELECT id FROM runtime_records WHERE record_type=? AND record_key=?', [type, key]);
	if (existing) await store.run('UPDATE runtime_records SET status=?,updated_at=?,payload_json=? WHERE id=?',
		[status, now, JSON.stringify(payload), existing.id]);
	else await store.run(`INSERT INTO runtime_records (record_type, record_key, lookup_key, secondary_key, status, schema_version, created_at, updated_at, payload_json, meta_json)
		VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, '{}')`, [type, key, teamId, topologyId, status, now, now, JSON.stringify(payload)]);
}

function missingPrevious(plan: ReturnType<typeof hostedTopologyPlanSchema.parse>, completedAt: string): HostedResourceObservation[] {
	return plan.actions.map((action) => ({ resourceId: action.resourceId, provider: action.provider, kind: action.kind,
		providerResourceId: action.providerResourceId, state: action.previousDigest ? 'healthy' : 'missing',
		managedBy: action.previousDigest ? 'treeseed' : null, observedDigest: action.previousDigest, observedAt: completedAt }));
}

export function createHostedTopologyExecutors(options: { controlPlaneStore?: any; hostedTopologyAdapter?: HostedTopologyExecutionAdapter;
	config?: any; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }) {
	const store = options.controlPlaneStore;
	const adapter: HostedTopologyExecutionAdapter = options.hostedTopologyAdapter
    ?? createDeploymentHostedAdapter({store, dataDir: options.config?.dataDir ?? '.treeseed/operations-runner',
      fetchImpl: options.fetchImpl, env: options.env});
  const execute = <T>(value: {run(adapter: HostedTopologyExecutionAdapter): Promise<T>}) => value.run(adapter);
	const plan = { namespace: 'infrastructure', operation: 'hosted-topology-plan', async run(input: Record<string, unknown>, context: any) {
		if (!store) throw new Error('Hosted topology planning requires the control-plane store.');
		const teamId = String(input.teamId ?? ''), declaration = hostedTopologyDeclarationSchema.parse(input.declaration);
		const stateBackend = hostedStateBackendSchema.parse(input.stateBackend);
		const connections = input.connections as Record<string, Record<string, unknown>>;
		const result = await execute({ run: async (adapter) =>
				planHostedTopology({ declaration, observations: await adapter.observe({ teamId, declaration, stateBackend, connections }),
					connections, stateBackend }) });
		await persistRecord(store, 'hosted_topology_plan', teamId, result.planId, result.topologyId, result, 'planned');
		return { plan: result };
	} };
	const apply = { namespace: 'infrastructure', operation: 'hosted-topology-apply', async run(input: Record<string, unknown>, context: any) {
		if (!store) throw new Error('Hosted topology execution requires the control-plane store.');
		const teamId = String(input.teamId ?? ''), topologyPlan = hostedTopologyPlanSchema.parse(input.plan);
		const authorized = authorizeHostedTopologyPlan(topologyPlan), completedAt = new Date().toISOString();
		await context.checkpoint({ phase: 'provider-apply', planDigest: topologyPlan.planDigest },
			{ kind: 'infrastructure.topology.apply.started', data: { teamId, planDigest: topologyPlan.planDigest } });
		const resources = await execute({ run: (adapter) => adapter.apply({ teamId, plan: authorized }) });
		const previous = await latestReceipt(store, teamId, topologyPlan.topologyId);
		const receipt = verifyHostedTopologyReadback({ plan: authorized,
			previousResources: previous?.resources ?? missingPrevious(topologyPlan, completedAt), resources, completedAt });
		await persistRecord(store, 'hosted_topology_plan', teamId, topologyPlan.planId, topologyPlan.topologyId, topologyPlan, 'applied');
		await persistRecord(store, 'hosted_topology_receipt', teamId, receipt.receiptId, receipt.topologyId, receipt, 'known-good');
		await context.checkpoint({ phase: 'read-back', receiptId: receipt.receiptId },
			{ kind: 'infrastructure.topology.known-good', data: { teamId, receiptId: receipt.receiptId } });
		return { receipt };
	} };
	const rollback = { namespace: 'infrastructure', operation: 'hosted-topology-rollback', async run(input: Record<string, unknown>, context: any) {
		if (!store) throw new Error('Hosted topology rollback requires the control-plane store.');
		const teamId = String(input.teamId ?? ''), execution = hostedTopologyRollbackExecutionSchema.parse(input.execution);
		authorizeHostedTopologyRollbackExecution(execution);
		const rollbackPlan = execution.rollback, source = await latestReceipt(store, teamId);
		if (!source || source.receiptId !== rollbackPlan.sourceReceiptId) throw new Error('Hosted topology rollback source is stale.');
		await context.checkpoint({ phase: 'provider-rollback', rollbackDigest: rollbackPlan.rollbackDigest },
			{ kind: 'infrastructure.topology.rollback.started', data: { teamId, rollbackDigest: rollbackPlan.rollbackDigest } });
		const resources = await execute({ run: (adapter) => adapter.rollback({ teamId, execution, sourceReceipt: source,
				sourcePlan: input.sourcePlan, targetPlan: input.targetPlan }) });
		const completedAt = new Date().toISOString(), receiptDigest = deploymentDigest({ sourceReceiptId: source.receiptId, resources, completedAt });
		const receipt = hostedTopologyReceiptSchema.parse({ ...source, receiptId: `topology-receipt-${receiptDigest.slice(7, 23)}`,
			resources, previousResources: source.resources, completedAt });
		await persistRecord(store, 'hosted_topology_receipt', teamId, receipt.receiptId, receipt.topologyId, receipt, 'known-good');
		return { receipt, rolledBackFrom: source.receiptId };
	} };
	return [plan, apply, rollback];
}
