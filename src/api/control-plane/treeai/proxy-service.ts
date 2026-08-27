import { TREEAI_UPSTREAM_OPERATIONS, type TreeAiInvocation, type TreeAiOperationId, type TreeAiService } from '@treeseed/sdk/treeai';
import type { OperationInvocationContext } from '../catalog/operation-registry.ts';

interface NodeConfiguration { endpoints: Record<TreeAiService, string>; token?: string; capabilities?: string[]; contractDigests?: Record<string, string>; version?: string }
export interface TreeAiNodeResolver { resolve(nodeId: string): Promise<NodeConfiguration | null> | NodeConfiguration | null }

function configuredNodes(environment: NodeJS.ProcessEnv): Record<string, NodeConfiguration> {
	const value = environment.TREESEED_TREEAI_NODES?.trim();
	if (!value) return {};
	const parsed = JSON.parse(value) as unknown;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('TREESEED_TREEAI_NODES must be a JSON object.');
	return parsed as Record<string, NodeConfiguration>;
}

export function environmentTreeAiNodeResolver(environment: NodeJS.ProcessEnv = process.env): TreeAiNodeResolver {
	const nodes = configuredNodes(environment);
	return { resolve: (nodeId) => nodes[nodeId] ?? null };
}

export class TreeAiProxyService {
	constructor(private readonly nodes: TreeAiNodeResolver, private readonly fetchImpl: typeof fetch = fetch) {}

	async invoke(nodeId: string, operationId: TreeAiOperationId, input: TreeAiInvocation, context: OperationInvocationContext) {
		const node = await this.nodes.resolve(nodeId);
		if (!node) throw Object.assign(new Error(`TreeAI node ${nodeId} is unavailable.`), { status: 404, code: 'treeai_node_not_found' });
		const operation = TREEAI_UPSTREAM_OPERATIONS.find((item) => item.operationId === operationId)!;
		const endpoint = node.endpoints[operation.service];
		if (!endpoint) throw Object.assign(new Error(`TreeAI ${operation.service} is disabled on node ${nodeId}.`), { status: 503, code: 'treeai_capability_unavailable' });
		let path = operation.path as string;
		for (const [name, value] of Object.entries(input.path ?? {})) path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
		if (/\{[^}]+\}/u.test(path)) throw Object.assign(new Error('TreeAI path input is incomplete.'), { status: 400, code: 'treeai_path_invalid' });
		const url = new URL(path, `${endpoint.replace(/\/+$/u, '')}/`);
		for (const [name, value] of Object.entries(input.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value));
		const headers = new Headers({ accept: context.requestHeaders?.accept ?? 'application/json', 'x-request-id': context.requestId });
		if (node.token) headers.set('authorization', `Bearer ${node.token}`);
		if (context.idempotencyKey) headers.set('idempotency-key', context.idempotencyKey);
		if (input.body !== undefined) headers.set('content-type', 'application/json');
		const response = await this.fetchImpl(url, { method: operation.method, headers, body: input.body === undefined ? undefined : JSON.stringify(input.body), signal: context.signal });
		if (!response.ok) {
			const detail = (await response.text()).slice(0, 2_000);
			throw Object.assign(new Error(`TreeAI ${operationId} returned ${response.status}: ${detail}`), { status: response.status, code: 'treeai_upstream_failed' });
		}
		if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) return response;
		return (response.headers.get('content-type') ?? '').includes('json') ? response.json() : { value: await response.text() };
	}
}
