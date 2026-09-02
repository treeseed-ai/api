import { hostedTopologyPlanSchema, hostedTopologyReceiptSchema, type HostedResourceObservation, type HostedTopologyDeclaration, type HostedTopologyPlan } from '@treeseed/sdk/deployment';
import { CloudflareHostedAdapter } from './cloudflare-hosted-adapter.ts';
import { resolveHostedProviderAuthority } from './hosted-provider-authority.ts';
import { RailwayHostedAdapter } from './railway-hosted-adapter.ts';

function ordered<T extends { id: string; dependsOn: string[] }>(resources: T[]) {
	const remaining = new Map(resources.map((resource) => [resource.id, resource])), result: T[] = [];
	while (remaining.size) {
		const ready = [...remaining.values()].filter((resource) => resource.dependsOn.every((id) => result.some((item) => item.id === id)));
		if (!ready.length) throw new Error('Hosted resource dependency graph cannot be executed.');
		for (const resource of ready.sort((a, b) => a.id.localeCompare(b.id))) { remaining.delete(resource.id); result.push(resource); }
	}
	return result;
}

async function managedIds(store: any, teamId: string) {
	const rows: any[] = await store.all(`SELECT payload_json FROM runtime_records WHERE record_type = 'hosted_topology_receipt' AND lookup_key = ?`, [teamId]);
	return new Set(rows.flatMap((row) => {
		try { return hostedTopologyReceiptSchema.parse(JSON.parse(row.payload_json)).resources.flatMap((resource) => resource.providerResourceId ? [resource.providerResourceId] : []); }
		catch { return []; }
	}));
}

export function createHostedProviderAdapter(options: { store: any; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv;
	externalAuthorityResolver?: (authority: any) => Promise<string> }) {
	const store = options.store, cloudflare = new CloudflareHostedAdapter(options.fetchImpl), railway = new RailwayHostedAdapter(options.fetchImpl);
	const authority = (teamId: string, connectionRef: string, provider: string, kind: string) => resolveHostedProviderAuthority({ store, teamId,
		connectionRef, provider, kind, env: options.env, externalResolver: options.externalAuthorityResolver });
	const observe = async (input: { teamId: string; declaration: HostedTopologyDeclaration; connections: Record<string, any> }) => {
		const managed = await managedIds(store, input.teamId), outputs: Record<string, Record<string, string>> = {}, observations: HostedResourceObservation[] = [];
		for (const resource of ordered(input.declaration.resources)) {
			const connection = input.connections[resource.provider], token = (await authority(input.teamId, connection.id, resource.provider, resource.kind)).token;
			const adapter = resource.provider === 'cloudflare' ? cloudflare : railway;
			const observation = await adapter.observeResource({ resource, config: connection.nonSecretConfig ?? {}, artifacts: input.declaration.artifacts,
				token, managed: false, outputs });
			if (observation.providerResourceId && managed.has(observation.providerResourceId)) observation.managedBy = 'treeseed';
			observations.push(observation);
			outputs[resource.id] = { 'provider-resource-id': observation.providerResourceId ?? '',
				'public-url': String(connection.nonSecretConfig?.[`${resource.id}.publicUrl`] ?? '') };
		}
		return observations;
	};
	const readback = async (teamId: string, plan: HostedTopologyPlan) => observe({ teamId,
		declaration: { schemaVersion: 'treeseed.hosted-topology/v1', id: plan.topologyId, environment: plan.environment, mutation: 'approval-required',
			platform: { repository: 'treeseed-ai/platform', commit: plan.platformCommit }, providerConnections: Object.fromEntries(Object.entries(plan.providerConnections).map(([provider, value]) => [provider, { connectionRef: value.connectionRef }])),
			artifacts: plan.artifacts, resources: plan.actions.map(({ desiredResource }) => desiredResource) },
		connections: Object.fromEntries(Object.entries(plan.providerConnections).map(([provider, value]) => [provider, { id: value.connectionRef, nonSecretConfig: value.nonSecretConfig }])) });
	return {
		observe,
		async apply(input: { teamId: string; plan: HostedTopologyPlan }) {
			const plan = hostedTopologyPlanSchema.parse(input.plan), outputs: Record<string, Record<string, string>> = {};
			for (const resource of ordered(plan.actions.map(({ desiredResource }) => desiredResource))) {
				const action = plan.actions.find((candidate) => candidate.resourceId === resource.id)!, binding = plan.providerConnections[action.provider]!;
				const token = (await authority(input.teamId, binding.connectionRef, action.provider, action.kind)).token;
				await (action.provider === 'cloudflare' ? cloudflare : railway).applyAction({ action, plan, token, outputs });
			}
			return readback(input.teamId, plan);
		},
		async rollback(input: { teamId: string; rollback: any }) {
			const sourceRow = await store.first(`SELECT payload_json FROM runtime_records WHERE record_type = 'hosted_topology_receipt' AND record_key = ? AND lookup_key = ?`, [input.rollback.sourceReceiptId, input.teamId]);
			if (!sourceRow) throw new Error('Hosted rollback source receipt is unavailable.');
			const source = hostedTopologyReceiptSchema.parse(JSON.parse(sourceRow.payload_json));
			const operationRows: any[] = await store.all(`SELECT input_json FROM platform_operations WHERE namespace = 'infrastructure' AND operation = 'hosted-topology-apply' ORDER BY created_at DESC`);
			const plans = operationRows.flatMap((row) => { try { return [hostedTopologyPlanSchema.parse(JSON.parse(row.input_json).plan)]; } catch { return []; } });
			const observed: HostedResourceObservation[] = [];
			for (const operation of input.rollback.operations) {
				const current = source.resources.find((resource) => resource.resourceId === operation.resourceId)!;
				const sourcePlan = plans.find((plan) => plan.planDigest === source.planDigest), sourceAction = sourcePlan?.actions.find((action) => action.resourceId === operation.resourceId);
				if (!sourceAction) throw new Error(`Hosted rollback source specification ${operation.resourceId} is unavailable.`);
				const binding = sourcePlan!.providerConnections[sourceAction.provider]!, token = (await authority(input.teamId, binding.connectionRef, sourceAction.provider, sourceAction.kind)).token;
				if (operation.action === 'delete-created') {
					if (sourceAction.provider === 'cloudflare') await cloudflare.deleteResource({ resource: sourceAction.desiredResource, providerResourceId: operation.providerResourceId, config: binding.nonSecretConfig, artifacts: sourcePlan!.artifacts, token });
					else await railway.deleteResource({ providerResourceId: operation.providerResourceId, token });
					observed.push({ ...current, state: 'missing', providerResourceId: null, managedBy: null, observedDigest: null, observedAt: new Date().toISOString() });
				} else if (operation.action === 'restore') {
					const prior = plans.flatMap((plan) => plan.actions.map((action) => ({ plan, action }))).find(({ action }) => action.resourceId === operation.resourceId && action.desiredDigest === operation.targetDigest);
					if (!prior) throw new Error(`Hosted rollback target specification ${operation.resourceId} is unavailable.`);
					const priorBinding = prior.plan.providerConnections[prior.action.provider]!, priorToken = (await authority(input.teamId, priorBinding.connectionRef, prior.action.provider, prior.action.kind)).token;
					const adapter = prior.action.provider === 'cloudflare' ? cloudflare : railway;
					await adapter.applyAction({ action: { ...prior.action, action: 'update', providerResourceId: current.providerResourceId }, plan: prior.plan, token: priorToken, outputs: {} });
					const item = await adapter.observeResource({ resource: prior.action.desiredResource, config: priorBinding.nonSecretConfig, artifacts: prior.plan.artifacts, token: priorToken, managed: true });
					if (item.observedDigest !== operation.targetDigest) throw new Error(`Hosted rollback read-back failed for ${operation.resourceId}.`);
					observed.push(item);
				} else observed.push(current);
			}
			return observed.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
		},
	};
}
