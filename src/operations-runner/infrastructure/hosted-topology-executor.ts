import {
	authorizeHostedTopologyPlan, authorizeHostedTopologyRollbackExecution, deploymentDigest, hostedStateBackendSchema,
	hostedTopologyDeclarationSchema, hostedTopologyPlanSchema, hostedTopologyReceiptSchema, hostedTopologyRollbackExecutionSchema,
	planHostedTopology, verifyHostedTopologyReadback, type AuthorizedHostedTopologyPlan, type HostedResourceObservation,
	type HostedStateBackend, type HostedTopologyDeclaration,
} from '@treeseed/sdk/deployment';
import type { HostedSecretOperationBinding } from '@treeseed/sdk/secrets-capability';
import { createDeploymentHostedAdapter } from './deployment-hosted-adapter.ts';
import { withHostedClientVaultLeases } from './hosted-client-vault-resolver.ts';

export interface HostedTopologyExecutionAdapter {
	observe(input: { teamId: string; declaration: HostedTopologyDeclaration; stateBackend: HostedStateBackend;
		connections: Record<string, Record<string, unknown>> }): Promise<HostedResourceObservation[]>;
	apply(input: { teamId: string; plan: AuthorizedHostedTopologyPlan; approval?: unknown }): Promise<HostedResourceObservation[]>;
	rollback(input: { teamId: string; execution: ReturnType<typeof hostedTopologyRollbackExecutionSchema.parse>; approval: unknown;
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

function binding(subjectType: HostedSecretOperationBinding['subjectType'], subjectDigest: string,
	value: { deploymentId: string; stackId: string; environment: 'staging' | 'production' }): HostedSecretOperationBinding {
	return { subjectType, subjectDigest, deploymentId: value.deploymentId, stackId: value.stackId, environment: value.environment };
}

export function createHostedTopologyExecutors(options: { controlPlaneStore?: any; hostedTopologyAdapter?: HostedTopologyExecutionAdapter;
	config?: any; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; externalAuthorityResolver?: any }) {
	const store = options.controlPlaneStore;
	const adapterFor = (interactiveAuthorityResolver?: any): HostedTopologyExecutionAdapter => options.hostedTopologyAdapter
		?? createDeploymentHostedAdapter({ store, dataDir: options.config?.dataDir ?? '.treeseed/operations-runner',
			fetchImpl: options.fetchImpl, env: options.env, externalAuthorityResolver: options.externalAuthorityResolver,
			interactiveAuthorityResolver });
	const execute = <T>(value: { teamId: string; leaseIds?: unknown; purpose: string; binding: HostedSecretOperationBinding;
		context: any; run(adapter: HostedTopologyExecutionAdapter): Promise<T> }) =>
		withHostedClientVaultLeases({ store, teamId: value.teamId, leaseIds: value.leaseIds, purpose: value.purpose,
			binding: value.binding, context: value.context, run: (resolver) => value.run(adapterFor(resolver)) });
	const plan = { namespace: 'infrastructure', operation: 'hosted-topology-plan', async run(input: Record<string, unknown>, context: any) {
		if (!store) throw new Error('Hosted topology planning requires the control-plane store.');
		const teamId = String(input.teamId ?? ''), declaration = hostedTopologyDeclarationSchema.parse(input.declaration);
		const stateBackend = hostedStateBackendSchema.parse(input.stateBackend);
		const connections = input.connections as Record<string, Record<string, unknown>>;
		const result = await execute({ teamId, leaseIds: input.credentialLeaseIds, purpose: 'hosted-topology-plan',
			binding: binding('declaration', deploymentDigest(declaration), declaration), context, run: async (adapter) =>
				planHostedTopology({ declaration, observations: await adapter.observe({ teamId, declaration, stateBackend, connections }),
					connections, stateBackend }) });
		await persistRecord(store, 'hosted_topology_plan', teamId, result.planId, result.topologyId, result, 'planned');
		return { plan: result };
	} };
	const apply = { namespace: 'infrastructure', operation: 'hosted-topology-apply', async run(input: Record<string, unknown>, context: any) {
		if (!store) throw new Error('Hosted topology execution requires the control-plane store.');
		const teamId = String(input.teamId ?? ''), topologyPlan = hostedTopologyPlanSchema.parse(input.plan);
		const authorized = authorizeHostedTopologyPlan(topologyPlan, input.approval as any), completedAt = new Date().toISOString();
		await context.checkpoint({ phase: 'provider-apply', planDigest: topologyPlan.planDigest },
			{ kind: 'infrastructure.topology.apply.started', data: { teamId, planDigest: topologyPlan.planDigest } });
		const resources = await execute({ teamId, leaseIds: input.credentialLeaseIds, purpose: 'hosted-topology-apply',
			binding: binding('plan', topologyPlan.planDigest, topologyPlan), context,
			run: (adapter) => adapter.apply({ teamId, plan: authorized, approval: input.approval }) });
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
		authorizeHostedTopologyRollbackExecution(execution, input.approval as any);
		const rollbackPlan = execution.rollback, source = await latestReceipt(store, teamId);
		if (!source || source.receiptId !== rollbackPlan.sourceReceiptId) throw new Error('Hosted topology rollback source is stale.');
		await context.checkpoint({ phase: 'provider-rollback', rollbackDigest: rollbackPlan.rollbackDigest },
			{ kind: 'infrastructure.topology.rollback.started', data: { teamId, rollbackDigest: rollbackPlan.rollbackDigest } });
		const resources = await execute({ teamId, leaseIds: input.credentialLeaseIds, purpose: 'hosted-topology-rollback',
			binding: binding('rollback', execution.executionDigest, execution), context,
			run: (adapter) => adapter.rollback({ teamId, execution, approval: input.approval, sourceReceipt: source,
				sourcePlan: input.sourcePlan, targetPlan: input.targetPlan }) });
		const completedAt = new Date().toISOString(), receiptDigest = deploymentDigest({ sourceReceiptId: source.receiptId, resources, completedAt });
		const receipt = hostedTopologyReceiptSchema.parse({ ...source, receiptId: `topology-receipt-${receiptDigest.slice(7, 23)}`,
			resources, previousResources: source.resources, completedAt });
		await persistRecord(store, 'hosted_topology_receipt', teamId, receipt.receiptId, receipt.topologyId, receipt, 'known-good');
		return { receipt, rolledBackFrom: source.receiptId };
	} };
	return [plan, apply, rollback];
}
