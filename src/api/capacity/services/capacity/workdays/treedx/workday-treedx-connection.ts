import { treeDxDelegationAuthority } from '../../../../../control-plane/treedx/delegation-authority.ts';
import { FetchTransport, TreeDxClient } from '@treeseed/treedx/treedx/client';
import { TreeDxInfrastructureClient } from '../../../../../control-plane/treedx/infrastructure-client.ts';

export interface WorkdayTreeDxConnectionStore {
	config: Record<string, unknown> & { fetchImpl?: typeof fetch };
	getProjectTreeDxLibrary(projectId: string): Promise<Record<string, unknown> | null>;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]): string {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return '';
}

export async function resolveWorkdayTreeDxConnection(
	store: WorkdayTreeDxConnectionStore,
	input: { projectId: string; repositoryId?: string; runId: string; capabilities: string[] },
) {
	const library = await store.getProjectTreeDxLibrary(input.projectId);
	const treeDx = record(record(record(library?.topology).contentRepository).treeDx);
	const baseUrl = text(process.env.TREESEED_TREEDX_URL, process.env.TREESEED_TREEDX_BASE_URL,
		store.config.TREESEED_TREEDX_URL, store.config.TREESEED_TREEDX_BASE_URL, store.config.treedxBaseUrl,
		treeDx.baseUrl, treeDx.registryUrl) || 'http://127.0.0.1:4000';
	const repositoryId = text(input.repositoryId, library?.repositoryId, treeDx.repositoryId);
	if (!repositoryId) return null;
	const token = treeDxDelegationAuthority().mint({
		actorId: text(store.config.TREESEED_TREEDX_PROXY_ACTOR_ID, store.config.treedxProxyActorId,
			process.env.TREESEED_TREEDX_PROXY_ACTOR_ID) || 'treeseed-api',
		tenantId: text(store.config.TREESEED_TREEDX_PROXY_TENANT_ID, store.config.treedxProxyTenantId,
			process.env.TREESEED_TREEDX_PROXY_TENANT_ID) || 'treeseed-control-plane',
		projectId: input.projectId,
		connectionId: text(treeDx.connectionId, treeDx.instanceId, 'treedx-workday-binding'),
		scope: { repositoryIds: [repositoryId], capabilities: input.capabilities, refs: ['*'], paths: ['**'], workdayRunId: input.runId },
	}).token;
	const normalizedBaseUrl = baseUrl.replace(/\/+$/u, '');
	const transport = new FetchTransport({ baseUrl: normalizedBaseUrl, token, timeoutMs: 60_000, fetchImpl: store.config.fetchImpl });
	return { baseUrl: normalizedBaseUrl, repositoryId, client: new TreeDxInfrastructureClient(new TreeDxClient({ baseUrl: normalizedBaseUrl, transport }), repositoryId) };
}
