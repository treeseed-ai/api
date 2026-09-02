import { createHash } from 'node:crypto';
import { deploymentDigest, type HostedResourceObservation, type HostedTopologyDeclaration, type HostedTopologyPlan } from '@treeseed/sdk/deployment';
import { resolveHostedParameter, requiredString } from './hosted-parameter-resolution.ts';

type Fetch = typeof fetch;
const root = 'https://api.cloudflare.com/client/v4';
const sha256 = (value: ArrayBuffer) => `sha256:${createHash('sha256').update(Buffer.from(value)).digest('hex')}`;

async function jsonRequest(fetchImpl: Fetch, token: string, path: string, init: RequestInit = {}) {
	const response = await fetchImpl(`${root}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } });
	if (!response.ok) throw new Error(`Cloudflare request failed (HTTP ${response.status}).`);
	const payload: any = await response.json();
	if (payload.success === false) throw new Error('Cloudflare rejected the hosted topology operation.');
	return payload.result;
}

function parameter(resource: any, name: string, context: any) { return resolveHostedParameter(resource.parameters[name], context); }
function identity(resource: any, context: any) { return String(parameter(resource, 'name', context) ?? resource.id); }

export class CloudflareHostedAdapter {
	constructor(private readonly fetchImpl: Fetch = fetch) {}

	async observeResource(input: { resource: HostedTopologyDeclaration['resources'][number]; config: Record<string, any>;
		artifacts: HostedTopologyDeclaration['artifacts']; token: string; managed: boolean; outputs?: Record<string, Record<string, string>> }): Promise<HostedResourceObservation> {
		const { resource, config, artifacts, token } = input, context = { config, artifacts, outputs: input.outputs }, observedAt = new Date().toISOString();
		const accountId = requiredString(config.accountId, 'accountId'), desiredDigest = deploymentDigest(resource);
		if (resource.kind === 'admin-application' || resource.kind === 'api-proxy') {
			const name = identity(resource, context);
			const response = await this.fetchImpl(`${root}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}`,
				{ headers: { authorization: `Bearer ${token}` } });
			if (response.status === 404) return { resourceId: resource.id, provider: 'cloudflare', kind: resource.kind, providerResourceId: null, state: 'missing', managedBy: null, observedDigest: null, observedAt };
			if (!response.ok) throw new Error(`Cloudflare Worker observation failed (HTTP ${response.status}).`);
			const artifact: any = parameter(resource, 'artifact', context);
			const matches = artifact?.digest && sha256(await response.arrayBuffer()) === artifact.digest;
			return { resourceId: resource.id, provider: 'cloudflare', kind: resource.kind, providerResourceId: name,
				state: 'healthy', managedBy: input.managed ? 'treeseed' : 'external', observedDigest: matches ? desiredDigest : deploymentDigest({ name, matches: false }), observedAt };
		}
		const zoneId = requiredString(parameter(resource, 'zoneId', context) ?? config.zoneId, 'zoneId');
		if (resource.kind === 'dns-record') {
			const name = requiredString(parameter(resource, 'name', context), 'name'), type = String(parameter(resource, 'type', context) ?? 'CNAME');
			const records: any[] = await jsonRequest(this.fetchImpl, token, `/zones/${encodeURIComponent(zoneId)}/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`);
			const record = records[0]; if (!record) return { resourceId: resource.id, provider: 'cloudflare', kind: resource.kind, providerResourceId: null, state: 'missing', managedBy: null, observedDigest: null, observedAt };
			const expected = { type, name, content: String(parameter(resource, 'content', context)), proxied: Boolean(parameter(resource, 'proxied', context) ?? true) };
			const matches = record.type === expected.type && record.name === expected.name && record.content === expected.content && Boolean(record.proxied) === expected.proxied;
			return { resourceId: resource.id, provider: 'cloudflare', kind: resource.kind, providerResourceId: record.id, state: 'healthy',
				managedBy: String(record.comment ?? '').includes('treeseed:') || input.managed ? 'treeseed' : 'external', observedDigest: matches ? desiredDigest : deploymentDigest(record), observedAt };
		}
		const setting: any = await jsonRequest(this.fetchImpl, token, `/zones/${encodeURIComponent(zoneId)}/settings/ssl`);
		const matches = setting.value === String(parameter(resource, 'mode', context));
		return { resourceId: resource.id, provider: 'cloudflare', kind: resource.kind, providerResourceId: `${zoneId}:ssl`, state: 'healthy',
			managedBy: input.managed ? 'treeseed' : 'external', observedDigest: matches ? desiredDigest : deploymentDigest(setting), observedAt };
	}

	async applyAction(input: { action: HostedTopologyPlan['actions'][number]; plan: HostedTopologyPlan; token: string; outputs: Record<string, Record<string, string>> }) {
		const { action, plan, token, outputs } = input, resource = action.desiredResource;
		const config = plan.providerConnections.cloudflare!.nonSecretConfig, context = { config, artifacts: plan.artifacts, outputs };
		if (action.action === 'noop' || action.action === 'adopt') return;
		const accountId = requiredString(config.accountId, 'accountId');
		if (resource.kind === 'admin-application' || resource.kind === 'api-proxy') {
			const name = identity(resource, context), artifact: any = parameter(resource, 'artifact', context);
			if (!artifact) throw new Error(`Cloudflare Worker ${resource.id} requires an artifact parameter.`);
			const source = await this.fetchImpl(artifact.source); if (!source.ok) throw new Error(`Hosted artifact download failed (HTTP ${source.status}).`);
			const body = await source.arrayBuffer(); if (sha256(body) !== artifact.digest) throw new Error('Hosted artifact digest verification failed.');
			const deployed = await this.fetchImpl(`${root}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}`,
				{ method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': source.headers.get('content-type') ?? 'application/javascript' }, body });
			if (!deployed.ok) throw new Error(`Cloudflare Worker deployment failed (HTTP ${deployed.status}).`);
			const publicUrl = parameter(resource, 'public-url', context) ?? config[`${resource.id}.publicUrl`];
			outputs[resource.id] = { name, 'public-url': typeof publicUrl === 'string' ? publicUrl : '' };
			return;
		}
		const zoneId = requiredString(parameter(resource, 'zoneId', context) ?? config.zoneId, 'zoneId');
		if (resource.kind === 'dns-record') {
			const record = { type: String(parameter(resource, 'type', context) ?? 'CNAME'), name: requiredString(parameter(resource, 'name', context), 'name'),
				content: requiredString(parameter(resource, 'content', context), 'content'), proxied: Boolean(parameter(resource, 'proxied', context) ?? true), comment: `treeseed:${action.desiredDigest}` };
			const path = action.providerResourceId ? `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(action.providerResourceId)}` : `/zones/${encodeURIComponent(zoneId)}/dns_records`;
			await jsonRequest(this.fetchImpl, token, path, { method: action.providerResourceId ? 'PUT' : 'POST', body: JSON.stringify(record) }); return;
		}
		await jsonRequest(this.fetchImpl, token, `/zones/${encodeURIComponent(zoneId)}/settings/ssl`, { method: 'PATCH', body: JSON.stringify({ value: requiredString(parameter(resource, 'mode', context), 'mode') }) });
	}

	async deleteResource(input: { resource: HostedTopologyDeclaration['resources'][number]; providerResourceId: string;
		config: Record<string, any>; artifacts: HostedTopologyDeclaration['artifacts']; token: string }) {
		const context = { config: input.config, artifacts: input.artifacts }, accountId = requiredString(input.config.accountId, 'accountId');
		if (input.resource.kind === 'admin-application' || input.resource.kind === 'api-proxy') {
			const response = await this.fetchImpl(`${root}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(input.providerResourceId)}`,
				{ method: 'DELETE', headers: { authorization: `Bearer ${input.token}` } });
			if (!response.ok && response.status !== 404) throw new Error(`Cloudflare Worker deletion failed (HTTP ${response.status}).`); return;
		}
		const zoneId = requiredString(parameter(input.resource, 'zoneId', context) ?? input.config.zoneId, 'zoneId');
		if (input.resource.kind === 'dns-record') { await jsonRequest(this.fetchImpl, input.token, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(input.providerResourceId)}`, { method: 'DELETE' }); return; }
		throw new Error('Cloudflare TLS policy deletion is not supported; rollback must restore a prior value.');
	}
}
