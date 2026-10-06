import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hostedTopologyReceiptSchema, type AuthorizedHostedTopologyPlan, type HostedResourceObservation, type HostedStateBackend, type HostedTopologyDeclaration, type HostedTopologyReceipt, type HostedTopologyRollbackExecution } from '@treeseed/sdk/deployment';
import { discoverHostedInfrastructure, HostedInfrastructureExecutor, hostedInfrastructureDiscoveryRequests, renderHostedInfrastructureRollbackWorkspace, renderHostedInfrastructureWorkspace, resolveHostedInfrastructureVaultAuthority, type HostedInfrastructureAuthorityRequest } from '@treeseed/deployment/infrastructure/opentofu';
import { resolveHostedVaultMaterial } from './hosted-provider-authority.ts';

async function managedIds(store: any, teamId: string) {
	const rows: any[] = await store.all(`SELECT payload_json FROM runtime_records WHERE record_type = 'hosted_topology_receipt' AND lookup_key = ?`, [teamId]);
	return new Set(rows.flatMap((row) => {
		try { return hostedTopologyReceiptSchema.parse(JSON.parse(row.payload_json)).resources.flatMap((resource) => resource.providerResourceId ? [resource.providerResourceId] : []); }
		catch { return []; }
	}));
}

export function createDeploymentHostedAdapter(options: { store: any; dataDir: string; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv;
	executor?: HostedInfrastructureExecutor }) {
	const resolver = (request: HostedInfrastructureAuthorityRequest) => resolveHostedVaultMaterial({ store: options.store, request,
		env: options.env });
	const operationRoot = async () => { await mkdir(options.dataDir, { recursive: true, mode: 0o700 }); return mkdtemp(join(options.dataDir, 'hosted-opentofu-')); };
	return {
		async observe(input: { teamId: string; declaration: HostedTopologyDeclaration; stateBackend: HostedStateBackend; connections: Record<string, any> }): Promise<HostedResourceObservation[]> {
			const requests = hostedInfrastructureDiscoveryRequests({ declaration: input.declaration, stateBackend: input.stateBackend });
			const authority = { schemaVersion: 'treeseed.hosted-infrastructure-authority/v1' as const, environment: input.declaration.environment,
				materials: await Promise.all(requests.map(resolver)) };
			const root = await operationRoot();
			try { return await discoverHostedInfrastructure({ declaration: input.declaration, stateBackend: input.stateBackend, connections: input.connections,
				authority, managedProviderResourceIds: await managedIds(options.store, input.teamId), root, fetchImpl: options.fetchImpl }); }
			finally { await rm(root, { recursive: true, force: true }); }
		},
		async apply(input: { teamId: string; plan: AuthorizedHostedTopologyPlan }): Promise<HostedResourceObservation[]> {
			const workspace = renderHostedInfrastructureWorkspace({ plan: input.plan }), root = await operationRoot();
			const authority = await resolveHostedInfrastructureVaultAuthority(workspace, resolver);
			const executor = options.executor ?? new HostedInfrastructureExecutor(undefined, options.fetchImpl);
			try { const execution = await executor.plan(workspace, root, authority); await executor.apply(workspace, root, authority, execution); return executor.readback(workspace, root, authority); }
			finally { await rm(root, { recursive: true, force: true }); }
		},
		async rollback(input: { teamId: string; execution: HostedTopologyRollbackExecution; sourceReceipt: HostedTopologyReceipt; sourcePlan: unknown; targetPlan: unknown }): Promise<HostedResourceObservation[]> {
			const workspace = renderHostedInfrastructureRollbackWorkspace({ execution: input.execution,
				sourceReceipt: input.sourceReceipt, sourcePlan: input.sourcePlan, targetPlan: input.targetPlan }), root = await operationRoot();
			const authority = await resolveHostedInfrastructureVaultAuthority(workspace, resolver);
			const executor = options.executor ?? new HostedInfrastructureExecutor(undefined, options.fetchImpl);
			try { const plan = await executor.plan(workspace, root, authority); await executor.apply(workspace, root, authority, plan); return executor.readback(workspace, root, authority); }
			finally { await rm(root, { recursive: true, force: true }); }
		},
	};
}
