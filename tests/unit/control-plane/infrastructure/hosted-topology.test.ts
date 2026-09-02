import { describe, expect, it } from 'vitest';
import { bindHostedStateBackend, deploymentDigest, hostedTopologyDeclarationSchema, hostedTopologyStateKey, planHostedTopology, planHostedTopologyRollback, planHostedTopologyRollbackExecution, type HostedTopologyDeclaration } from '@treeseed/sdk/deployment';
import { createHostedTopologyService } from '../../../../src/api/control-plane/repositories/infrastructure/hosted-topology-service.ts';
import { createHostedTopologyExecutors } from '../../../../src/operations-runner/infrastructure/hosted-topology-executor.ts';

const now = '2026-09-02T12:00:00.000Z';
const digest = (marker: string) => `sha256:${marker.repeat(64)}`;
const connections = { cloudflare: { connectionRef: 'cloudflare-production', nonSecretConfig: { deploymentEnvironment: 'production', accountId: 'account' } },
	railway: { connectionRef: 'railway-production', nonSecretConfig: { deploymentEnvironment: 'production', workspaceId: 'workspace', projectId: 'project', environmentId: 'environment' } } };
function declaration(): HostedTopologyDeclaration { return hostedTopologyDeclarationSchema.parse({
	schemaVersion: 'treeseed.hosted-topology/v1', id: 'production', teamId: 'team-1', deploymentId: 'treeseed-cloud', stackId: 'control-plane', environment: 'production', mutation: 'approval-required',
	platform: { repository: 'treeseed-ai/platform', commit: 'a'.repeat(40) },
	stateBackend: { connectionRef: 'cloudflare-state' },
	providerConnections: { cloudflare: { connectionRef: 'cloudflare-production' }, railway: { connectionRef: 'railway-production' } },
	artifacts: { api: { digest: digest('a'), source: 'https://example.test/api.tgz' } },
	resources: [
		{ id: 'admin', provider: 'cloudflare', kind: 'admin-application', dependsOn: [], parameters: { name: { literal: 'treeseed-admin' } }, adoption: { mode: 'adopt-or-create', replacement: 'forbidden' } },
		{ id: 'api', provider: 'railway', kind: 'control-plane-api', dependsOn: [], parameters: { artifact: { artifact: 'api' } }, adoption: { mode: 'adopt-or-create', replacement: 'forbidden' } },
	],
}); }
const backend = () => bindHostedStateBackend({ schemaVersion: 'treeseed.hosted-state-backend/v1', type: 's3', teamId: 'team-1', deploymentId: 'treeseed-cloud', environment: 'production', stackId: 'control-plane', connectionRef: 'cloudflare-state', bucket: 'treeseed-state', key: hostedTopologyStateKey({ teamId: 'team-1', deploymentId: 'treeseed-cloud', environment: 'production', stackId: 'control-plane' }), region: 'auto', endpoint: 'https://r2.example.test', usePathStyle: true, encryptionKeyRef: 'treeseed-cloud-state' });
function missing(value: HostedTopologyDeclaration) { return value.resources.map((resource) => ({ resourceId: resource.id, provider: resource.provider, kind: resource.kind, providerResourceId: null, state: 'missing' as const, managedBy: null, observedDigest: null, observedAt: now })); }
function healthy(value: HostedTopologyDeclaration) { return value.resources.map((resource) => ({ resourceId: resource.id, provider: resource.provider, kind: resource.kind, providerResourceId: `${resource.provider}-${resource.id}`, state: 'healthy' as const, managedBy: 'treeseed' as const, observedDigest: deploymentDigest(resource), observedAt: now })); }

function store() {
	const operations: any[] = [], records: any[] = [];
	return {
		operations, records,
		async principalCanAccessTeam() { return true; }, async getTeamAccessSummary() { return { permissions: ['infrastructure:read:team', 'infrastructure:write:team'] }; },
		async getTeamServiceConnection(_teamId: string, id: string) { return id === 'cloudflare-state'
			? { id, providerId: 'cloudflare', status: 'active', nonSecretConfig: { stateBucket: 'treeseed-state', stateRegion: 'auto', stateEndpoint: 'https://r2.example.test', stateEncryptionKeyRef: 'treeseed-cloud-state' }, capabilities: [{ capabilityType: 'object-storage', credentialProfileId: 'cloudflare-storage', status: 'configured' }] }
			: { id, providerId: id.startsWith('cloudflare') ? 'cloudflare' : 'railway', status: 'active', nonSecretConfig: connections[id.startsWith('cloudflare') ? 'cloudflare' : 'railway'].nonSecretConfig }; },
		async createPlatformOperation(input: any) { const operation = { id: `operation-${operations.length + 1}`, status: 'queued', ...input }; operations.push(operation); return operation; },
		async first(sql: string) { if (sql.includes('runtime_records')) return records.at(-1) ?? null; return null; },
		async findPlatformOperationById() { return null; },
		async run(_sql: string, values: unknown[]) { records.push({ payload_json: values[5] }); },
	};
}

describe('hosted topology control-plane and runner', () => {
	it('plans read-only from team-scoped live observations and rejects unavailable connections', async () => {
		const state = store(), value = declaration();
		const service = createHostedTopologyService(state, { async observe() { return missing(value); } });
		const plan = await service.plan({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { declaration: value });
		expect(plan.actions.every(({ action }) => action === 'create')).toBe(true);
		state.getTeamServiceConnection = async () => null as any;
		await expect(service.plan({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { declaration: value })).rejects.toMatchObject({ code: 'hosted_provider_connection_unavailable' });
	});

	it('queues only exact approved plans with concurrency and no plaintext credentials', async () => {
		const state = store(), value = declaration();
		const service = createHostedTopologyService(state, { async observe() { return missing(value); } });
		const plan = planHostedTopology({ declaration: value, observations: missing(value), connections, stateBackend: backend() });
		const approval = { schemaVersion: 'treeseed.hosted-topology-approval/v1' as const, planDigest: plan.planDigest, teamId: plan.teamId, deploymentId: plan.deploymentId, stackId: plan.stackId, environment: plan.environment, backendBindingDigest: plan.stateBackend!.bindingDigest, decision: 'approved' as const, approvedBy: 'human-owner', approvedAt: now };
		await expect(service.apply({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { plan, approval }, 'wrong', 'id-1')).rejects.toMatchObject({ code: 'hosted_topology_plan_precondition_failed' });
		const queued = await service.apply({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { plan, approval }, `"${plan.planDigest}"`, 'id-1');
		expect(queued).toMatchObject({ namespace: 'infrastructure', operation: 'hosted-topology-apply', idempotencyKey: 'id-1' });
		await expect(service.plan({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { declaration: value, apiToken: 'forbidden' })).rejects.toMatchObject({ code: 'plaintext_secret_rejected' });
	});

	it('executes through an injected adapter, verifies read-back, and persists a redacted receipt', async () => {
		const state = store(), value = declaration();
		const plan = planHostedTopology({ declaration: value, observations: missing(value), connections, stateBackend: backend() });
		const approval = { schemaVersion: 'treeseed.hosted-topology-approval/v1' as const, planDigest: plan.planDigest, teamId: plan.teamId, deploymentId: plan.deploymentId, stackId: plan.stackId, environment: plan.environment, backendBindingDigest: plan.stateBackend!.bindingDigest, decision: 'approved' as const, approvedBy: 'human-owner', approvedAt: now };
		const [executor, rollbackExecutor] = createHostedTopologyExecutors({ controlPlaneStore: state, hostedTopologyAdapter: { async apply() { return healthy(value); }, async rollback() { return missing(value); } } });
		const checkpoints: unknown[] = [];
		const result = await executor!.run({ teamId: 'team-1', plan, approval }, { async checkpoint(output: unknown) { checkpoints.push(output); } }) as any;
		expect(result.receipt.state).toBe('known-good');
		expect(state.records).toHaveLength(1);
		expect(JSON.stringify(state.records)).not.toContain('human-owner');
		expect(checkpoints).toHaveLength(2);
		const rollback = planHostedTopologyRollback(result.receipt);
		const targetDeclaration = hostedTopologyDeclarationSchema.parse({ ...value, resources: [] });
		const targetPlan = planHostedTopology({ declaration: targetDeclaration, observations: [], connections, stateBackend: backend() });
		const execution = planHostedTopologyRollbackExecution({ rollback, sourceReceipt: result.receipt, sourcePlan: plan, targetPlan });
		const rollbackApproval = { schemaVersion: 'treeseed.hosted-topology-rollback-execution-approval/v1' as const,
			executionDigest: execution.executionDigest, teamId: execution.teamId, deploymentId: execution.deploymentId, stackId: execution.stackId, environment: execution.environment, backendBindingDigest: execution.backendBindingDigest, decision: 'approved' as const, approvedBy: 'human-owner', approvedAt: now };
		const service = createHostedTopologyService(state, { async observe() { return healthy(value); } });
		await expect(service.rollback({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { execution, approval: rollbackApproval, sourcePlan: plan, targetPlan }, 'wrong')).rejects.toMatchObject({ code: 'hosted_topology_rollback_precondition_failed' });
		const queued = await service.rollback({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { execution, approval: rollbackApproval, sourcePlan: plan, targetPlan }, execution.executionDigest, 'rollback-1');
		expect(queued).toMatchObject({ operation: 'hosted-topology-rollback', input: { execution: { executionDigest: execution.executionDigest } } });
		const rolledBack = await rollbackExecutor!.run({ teamId: 'team-1', execution, approval: rollbackApproval, sourcePlan: plan, targetPlan }, { async checkpoint() {} }) as any;
		expect(rolledBack).toMatchObject({ rolledBackFrom: result.receipt.receiptId, receipt: { resources: [{ state: 'missing' }, { state: 'missing' }] } });
		expect(JSON.stringify(state.records)).not.toContain('human-owner');
	});
});
