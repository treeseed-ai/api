import { describe, expect, it } from 'vitest';
import { bindHostedStateBackend, deploymentDigest, hostedTopologyDeclarationSchema, hostedTopologyStateKey, planHostedTopology, planHostedTopologyRollback, planHostedTopologyRollbackExecution, type HostedTopologyDeclaration } from '@treeseed/sdk/deployment';
import { createHostedTopologyService } from '../../../../src/api/control-plane/repositories/infrastructure/hosted-topology-service.ts';
import { createHostedTopologyExecutors } from '../../../../src/operations-runner/infrastructure/hosted-topology-executor.ts';

const now = '2026-09-02T12:00:00.000Z';
const digest = (marker: string) => `sha256:${marker.repeat(64)}`;
const connections = { cloudflare: { connectionRef: 'cloudflare-production', nonSecretConfig: { deploymentEnvironment: 'production', accountId: 'account' } },
	railway: { connectionRef: 'railway-production', nonSecretConfig: { deploymentEnvironment: 'production', workspaceId: 'workspace', projectId: 'project', environmentId: 'environment', environmentName: 'production' } } };
function declaration(): HostedTopologyDeclaration { return hostedTopologyDeclarationSchema.parse({
	schemaVersion: 'treeseed.hosted-topology/v1', id: 'production', teamId: 'team-1', deploymentId: 'treeseed-cloud', stackId: 'control-plane', environment: 'production', mutation: 'agent-authorized',
	platform: { repository: 'treeseed-ai/platform', commit: 'a'.repeat(40) },
	stateBackend: { connectionRef: 'cloudflare-state' },
	providerConnections: { cloudflare: { connectionRef: 'cloudflare-production' }, railway: { connectionRef: 'railway-production' } },
	artifacts: { admin: { kind: 'archive', format: 'tar+gzip', digest: digest('a'), source: 'https://artifacts.example.test/admin.tgz' },
		api: { kind: 'oci-image', digest: digest('b'), identity: `treeseed/api@${digest('b')}` } },
	resources: [
		{ id: 'admin', provider: 'cloudflare', kind: 'pages-application', dependsOn: [], parameters: { name: { literal: 'treeseed-admin' },
			artifact: { artifact: 'admin' }, 'artifact-format': { literal: 'tar+gzip' }, 'production-branch': { literal: 'main' },
			'destination-dir': { literal: '.' } }, adoption: { mode: 'adopt-or-create', replacement: 'forbidden' } },
		{ id: 'api', provider: 'railway', kind: 'control-plane-api', dependsOn: [], parameters: { artifact: { artifact: 'api' } }, adoption: { mode: 'adopt-or-create', replacement: 'forbidden' } },
	],
}); }
const backend = () => bindHostedStateBackend({ schemaVersion: 'treeseed.hosted-state-backend/v1', type: 's3', teamId: 'team-1', deploymentId: 'treeseed-cloud', environment: 'production', stackId: 'control-plane', connectionRef: 'cloudflare-state', bucket: 'treeseed-state', key: hostedTopologyStateKey({ teamId: 'team-1', deploymentId: 'treeseed-cloud', environment: 'production', stackId: 'control-plane' }), region: 'auto', endpoint: 'https://r2.example.test', usePathStyle: true, encryptionKeyRef: 'treeseed-cloud-state' });
function missing(value: HostedTopologyDeclaration) { return value.resources.map((resource) => ({ resourceId: resource.id, provider: resource.provider, kind: resource.kind, providerResourceId: null, state: 'missing' as const, managedBy: null, observedDigest: null, observedAt: now })); }
function healthy(value: HostedTopologyDeclaration) { return value.resources.map((resource) => ({ resourceId: resource.id, provider: resource.provider, kind: resource.kind, providerResourceId: `${resource.provider}-${resource.id}`, state: 'healthy' as const, managedBy: 'treeseed' as const, observedDigest: deploymentDigest(resource), observedAt: now })); }

function store() {
	const operations: any[] = [], records: any[] = [];
	const serviceConnections = [
		{ id: 'connection-state-id', displayName: 'cloudflare-state', providerId: 'cloudflare', status: 'active', nonSecretConfig: { stateBucket: 'treeseed-state', stateRegion: 'auto', stateEndpoint: 'https://r2.example.test', stateEncryptionKeyRef: 'treeseed-cloud-state' }, capabilities: [
			{ capabilityType: 'object-storage', credentialProfileId: 's3-state-session', status: 'configured' },
			{ capabilityType: 'state-encryption', credentialProfileId: 'opentofu-state-encryption', status: 'configured' },
		] },
		{ id: 'connection-cloudflare-id', displayName: 'cloudflare-production', providerId: 'cloudflare', status: 'active', nonSecretConfig: connections.cloudflare.nonSecretConfig },
		{ id: 'connection-railway-id', displayName: 'railway-production', providerId: 'railway', status: 'active', nonSecretConfig: connections.railway.nonSecretConfig },
	];
	return {
		operations, records,
		async principalCanAccessTeam() { return true; }, async getTeamAccessSummary() { return { permissions: ['infrastructure:read:team', 'infrastructure:write:team'] }; },
		async getTeamServiceConnection(_teamId: string, id: string) { return serviceConnections.find((connection) => connection.id === id) ?? null; },
		async listTeamServiceConnections() { return serviceConnections; },
		async createPlatformOperation(input: any) { const operation = { id: `operation-${operations.length + 1}`, status: 'queued', ...input }; operations.push(operation); return operation; },
		async first(sql: string) {
			if (sql.includes('provider_credential_authorities')) return { scheme: 'external-vault' };
			if (sql.startsWith('SELECT id FROM runtime_records')) return null;
			if (sql.includes('runtime_records')) return records.at(-1) ?? null;
			return null;
		},
		async findPlatformOperationById() { return null; },
		async run(sql: string, values: unknown[]) {
			if (sql.startsWith('INSERT INTO runtime_records')) records.push({ id: records.length + 1, payload_json: values[7] });
		},
	};
}

const unusedVault = { async createLease() { throw new Error('External authorities must not create interactive leases.'); } };

describe('hosted topology control-plane and runner', () => {
	it('plans read-only from team-scoped live observations and rejects unavailable connections', async () => {
		const state = store(), value = declaration();
		const service = createHostedTopologyService(state, unusedVault);
		const planned = await service.plan({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { declaration: value });
		expect(planned).toMatchObject({ operation: { operation: 'hosted-topology-plan' }, credentialLeases: [] });
		state.getTeamServiceConnection = async () => null as any;
		state.listTeamServiceConnections = async () => [
			{ id: 'duplicate-1', displayName: 'cloudflare-production', providerId: 'cloudflare', status: 'active' },
			{ id: 'duplicate-2', displayName: 'cloudflare-production', providerId: 'cloudflare', status: 'active' },
		];
		await expect(service.plan({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { declaration: value })).rejects.toMatchObject({ code: 'hosted_provider_connection_ambiguous' });
		state.listTeamServiceConnections = async () => [];
		await expect(service.plan({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { declaration: value })).rejects.toMatchObject({ code: 'hosted_provider_connection_unavailable' });
	});

	it('queues only exact agent-authorized plans with concurrency and no plaintext credentials', async () => {
		const state = store(), value = declaration();
		const service = createHostedTopologyService(state, unusedVault);
		const plan = planHostedTopology({ declaration: value, observations: missing(value), connections, stateBackend: backend() });
		await expect(service.apply({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { plan }, 'wrong', 'id-1')).rejects.toMatchObject({ code: 'hosted_topology_plan_precondition_failed' });
		const queued = await service.apply({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { plan }, `"${plan.planDigest}"`, 'id-1');
		expect(queued).toMatchObject({ operation: { namespace: 'infrastructure', operation: 'hosted-topology-apply', idempotencyKey: 'id-1' }, credentialLeases: [] });
		await expect(service.plan({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { declaration: value, apiToken: 'forbidden' })).rejects.toMatchObject({ code: 'plaintext_secret_rejected' });
	});

	it('creates exact interactive leases for provider, state backend, and state encryption authority', async () => {
		const state = store(), value = declaration(), created: any[] = [];
		const originalFirst = state.first;
		state.first = async (sql: string) => sql.includes('provider_credential_authorities')
			? { scheme: 'client-encrypted', status: 'interactive-only' } : originalFirst(sql);
		const service = createHostedTopologyService(state, {
			async createLease(_principal: unknown, _teamId: string, body: any) {
				const item = { id: `lease-${created.length + 1}`, purpose: body.purpose, hostedBinding: body.hostedBinding };
				created.push(body); return item;
			},
		});
		const plan = planHostedTopology({ declaration: value, observations: missing(value), connections, stateBackend: backend() });
		const accepted = await service.apply({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { plan }, plan.planDigest);
		expect(accepted.credentialLeases).toHaveLength(4);
		expect(created.map((item) => item.credentialProfileId).sort()).toEqual([
			'cloudflare-runtime', 'opentofu-state-encryption', 'railway-workspace', 's3-state-session',
		]);
		expect(created.find((item) => item.credentialProfileId === 's3-state-session')).toMatchObject({ capabilityType: 'object-storage' });
		expect(created.find((item) => item.credentialProfileId === 'opentofu-state-encryption')).toMatchObject({ capabilityType: 'state-encryption' });
		expect(created.every((item) => item.hostedBinding.subjectDigest === plan.planDigest)).toBe(true);
	});

	it('executes through an injected adapter, verifies read-back, and persists a redacted receipt', async () => {
		const state = store(), value = declaration();
		const plan = planHostedTopology({ declaration: value, observations: missing(value), connections, stateBackend: backend() });
		const [, executor, rollbackExecutor] = createHostedTopologyExecutors({ controlPlaneStore: state, hostedTopologyAdapter: {
			async observe() { return missing(value); }, async apply() { return healthy(value); }, async rollback() { return missing(value); },
		} });
		const checkpoints: unknown[] = [];
		const result = await executor!.run({ teamId: 'team-1', plan }, { async checkpoint(output: unknown) { checkpoints.push(output); } }) as any;
		expect(result.receipt.state).toBe('known-good');
		expect(state.records).toHaveLength(2);
		expect(JSON.stringify(state.records)).not.toContain('approval');
		expect(checkpoints).toHaveLength(2);
		const rollback = planHostedTopologyRollback(result.receipt);
		const targetDeclaration = hostedTopologyDeclarationSchema.parse({ ...value, resources: [] });
		const targetPlan = planHostedTopology({ declaration: targetDeclaration, observations: [], connections, stateBackend: backend() });
		const execution = planHostedTopologyRollbackExecution({ rollback, sourceReceipt: result.receipt, sourcePlan: plan, targetPlan });
		const service = createHostedTopologyService(state, unusedVault);
		await expect(service.rollback({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { execution, sourcePlan: plan, targetPlan }, 'wrong')).rejects.toMatchObject({ code: 'hosted_topology_rollback_precondition_failed' });
		const queued = await service.rollback({ id: 'owner', roles: ['platform_admin'] }, 'team-1', { execution, sourcePlan: plan, targetPlan }, execution.executionDigest, 'rollback-1');
		expect(queued).toMatchObject({ operation: { operation: 'hosted-topology-rollback', input: { execution: { executionDigest: execution.executionDigest } } }, credentialLeases: [] });
		const rolledBack = await rollbackExecutor!.run({ teamId: 'team-1', execution, sourcePlan: plan, targetPlan }, { async checkpoint() {} }) as any;
		expect(rolledBack).toMatchObject({ rolledBackFrom: result.receipt.receiptId, receipt: { resources: [{ state: 'missing' }, { state: 'missing' }] } });
		expect(JSON.stringify(state.records)).not.toContain('approval');
	});
});
