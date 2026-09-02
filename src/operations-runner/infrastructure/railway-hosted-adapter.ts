import { deploymentDigest, type HostedResourceObservation, type HostedTopologyDeclaration, type HostedTopologyPlan } from '@treeseed/sdk/deployment';
import { resolveHostedParameter, requiredString } from './hosted-parameter-resolution.ts';

type Fetch = typeof fetch;
const endpoint = 'https://backboard.railway.com/graphql/v2';

async function railway(fetchImpl: Fetch, token: string, query: string, variables: Record<string, unknown>) {
	const response = await fetchImpl(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
	if (!response.ok) throw new Error(`Railway request failed (HTTP ${response.status}).`);
	const payload: any = await response.json();
	if (payload.errors?.length) throw new Error(`Railway rejected the hosted topology operation: ${payload.errors[0].message}.`);
	return payload.data;
}

function parameter(resource: any, name: string, context: any) { return resolveHostedParameter(resource.parameters[name], context); }

export class RailwayHostedAdapter {
	constructor(private readonly fetchImpl: Fetch = fetch) {}

	private async inventory(token: string, projectId: string, environmentId: string) {
		const data = await railway(this.fetchImpl, token, `query TreeSeedHostedInventory($projectId: String!, $environmentId: String!) {
			project(id: $projectId) { services { edges { node { id name } } } }
			variables(projectId: $projectId, environmentId: $environmentId)
		}`, { projectId, environmentId });
		return { services: (data.project?.services?.edges ?? []).map((edge: any) => edge.node), variables: data.variables ?? {} };
	}

	async observeResource(input: { resource: HostedTopologyDeclaration['resources'][number]; config: Record<string, any>;
		artifacts: HostedTopologyDeclaration['artifacts']; token: string; managed: boolean; outputs?: Record<string, Record<string, string>> }): Promise<HostedResourceObservation> {
		const { resource, config, artifacts, token } = input, context = { config, artifacts, outputs: input.outputs }, observedAt = new Date().toISOString();
		const projectId = requiredString(config.projectId, 'projectId'), environmentId = requiredString(config.environmentId, 'environmentId');
		const name = String(parameter(resource, 'name', context) ?? resource.id), inventory = await this.inventory(token, projectId, environmentId);
		const service = inventory.services.find((item: any) => item.name === name);
		if (!service) return { resourceId: resource.id, provider: 'railway', kind: resource.kind, providerResourceId: null, state: 'missing', managedBy: null, observedDigest: null, observedAt };
		const marker = inventory.variables[service.id]?.TREESEED_RESOURCE_DIGEST ?? inventory.variables[`TREESEED_RESOURCE_DIGEST_${resource.id.toUpperCase().replaceAll('-', '_')}`];
		return { resourceId: resource.id, provider: 'railway', kind: resource.kind, providerResourceId: service.id, state: 'healthy',
			managedBy: marker || input.managed ? 'treeseed' : 'external', observedDigest: marker === deploymentDigest(resource) ? marker : deploymentDigest({ serviceId: service.id, marker: marker ?? null }), observedAt };
	}

	async applyAction(input: { action: HostedTopologyPlan['actions'][number]; plan: HostedTopologyPlan; token: string; outputs: Record<string, Record<string, string>> }) {
		const { action, plan, token, outputs } = input, resource = action.desiredResource;
		if (action.action === 'noop' || action.action === 'adopt') return;
		const config = plan.providerConnections.railway!.nonSecretConfig, context = { config, artifacts: plan.artifacts, outputs };
		const projectId = requiredString(config.projectId, 'projectId'), environmentId = requiredString(config.environmentId, 'environmentId');
		const name = String(parameter(resource, 'name', context) ?? resource.id);
		let serviceId = action.providerResourceId;
		if (!serviceId) {
			const artifact: any = parameter(resource, 'artifact', context);
			const image = resource.kind === 'postgresql' ? String(parameter(resource, 'image', context) ?? 'postgres:17') : artifact?.source;
			const data = await railway(this.fetchImpl, token, `mutation TreeSeedServiceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
				{ input: { projectId, name, source: image ? { image } : undefined } });
			serviceId = data.serviceCreate.id;
		}
		const variables: Record<string, string> = { TREESEED_RESOURCE_DIGEST: action.desiredDigest };
		for (const [key, value] of Object.entries(resource.parameters)) if (key.startsWith('variable.')) {
			const resolved = resolveHostedParameter(value as any, context); if (resolved !== undefined) variables[key.slice(9)] = String(resolved);
		}
		await railway(this.fetchImpl, token, `mutation TreeSeedVariables($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
			{ input: { projectId, environmentId, serviceId, variables } });
		await railway(this.fetchImpl, token, `mutation TreeSeedDeploy($environmentId: String!, $serviceId: String!) { serviceInstanceDeploy(environmentId: $environmentId, serviceId: $serviceId) }`, { environmentId, serviceId });
		outputs[resource.id] = { 'service-id': serviceId!, 'public-url': String(parameter(resource, 'publicUrl', context) ?? config[`${resource.id}.publicUrl`] ?? '') };
	}

	async deleteResource(input: { providerResourceId: string; token: string }) {
		await railway(this.fetchImpl, input.token, `mutation TreeSeedServiceDelete($id: String!) { serviceDelete(id: $id) }`, { id: input.providerResourceId });
	}
}
