import { FetchTransport, TreeDxClient } from '@treeseed/treedx/treedx/client';
import { TREEDX_OPENAPI_OPERATIONS } from '@treeseed/treedx';
import { treeDxScopedPathAllows } from '../../capacity/policy/treedx-proxy-access.ts';
export { treeDxScopedPathAllows } from '../../capacity/policy/treedx-proxy-access.ts';

type InputRecord = Record<string, unknown>;
type AdoptedOperation = (typeof TREEDX_OPENAPI_OPERATIONS)[number];

const operations = new Map<string, AdoptedOperation>(TREEDX_OPENAPI_OPERATIONS.map((operation) => [operation.operationId, operation]));
const reservedQueryKeys = new Set(['assignmentId', 'treeDxProxyHandleId', 'treeDxProxyToken']);
const contentExtensions = ['.mdx', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml'];

export function treeDxBoundedScopedPaths(allowed: string[], requested: string[]) {
	return requested.length ? requested.filter((path) => allowed.some((pattern) => treeDxScopedPathAllows(pattern, path))) : [...allowed];
}

function record(value: unknown): InputRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as InputRecord : {};
}

function camelCase(value: string) {
	return value.replace(/_([a-z])/gu, (_match, character: string) => character.toUpperCase());
}

export function requireTreeDxOperation(operationId: string): AdoptedOperation {
	const operation = operations.get(operationId);
	if (!operation) throw new Error(`TreeDX operation ${operationId} is absent from the adopted OpenAPI contract.`);
	return operation;
}

export function treeDxPathParameters(operation: AdoptedOperation, inputPath: unknown) {
	const source = record(inputPath);
	return Object.fromEntries([...operation.path.matchAll(/\{([^}]+)\}/gu)].map((match) => {
		const parameter = match[1]!;
		const value = source[parameter] ?? source[camelCase(parameter)];
		if (value === undefined || value === null || String(value).trim() === '') {
			throw new Error(`TreeDX operation ${operation.operationId} requires path parameter ${parameter}.`);
		}
		return [parameter, String(value)];
	}));
}

export function treeDxQuery(value: unknown) {
	return Object.fromEntries(Object.entries(record(value)).filter(([key, entry]) => !reservedQueryKeys.has(key)
		&& ['string', 'number', 'boolean'].includes(typeof entry))) as Record<string, string | number | boolean>;
}

export function treeDxOperationScope(operation: AdoptedOperation, input: { path?: unknown; query?: unknown; body?: unknown },
	fallbackRepositoryIds: string[] = []) {
	const path = record(input.path); const query = record(input.query); const body = record(input.body);
	const values = [path, query, body];
	const strings = (names: string[]) => values.flatMap((source) => names.flatMap((name) => {
		const value = source[name];
		return Array.isArray(value) ? value.map(String) : value === undefined || value === null ? [] : [String(value)];
	}));
	const requestedPaths = [...new Set(strings(['path', 'paths', 'scopePaths']))];
	const scopedPaths = operation.operationId === 'readRepositoryFile'
		? requestedPaths.flatMap((value) => /\.[^/]+$/u.test(value) ? [value] : [value, ...contentExtensions.map((extension) => `${value}${extension}`)])
		: requestedPaths;
	return {
		repoIds: [...new Set([...strings(['repoId', 'repo_id', 'repositoryId', 'repository_id']), ...fallbackRepositoryIds])],
		capabilities: [...operation.requiredCapabilities],
		refs: [...new Set(strings(['ref', 'refs', 'baseRef', 'targetRef', 'sourceRef']))],
		paths: [...new Set(scopedPaths)],
	};
}

export function createOfficialTreeDxClient(input: { baseUrl: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
	const transport = new FetchTransport({ baseUrl: input.baseUrl, token: input.token, fetchImpl: input.fetchImpl, timeoutMs: input.timeoutMs ?? 15_000 });
	return new TreeDxClient({ baseUrl: input.baseUrl, transport });
}

export async function invokeOfficialTreeDxOperation(input: {
	client: TreeDxClient;
	operation: AdoptedOperation;
	path: unknown;
	query: unknown;
	body: unknown;
	requestId: string;
	traceparent?: string;
	idempotencyKey?: string;
	signal?: AbortSignal;
}) {
	return input.client.operation(input.operation.method, input.operation.path, {
		pathParams: treeDxPathParameters(input.operation, input.path),
		query: treeDxQuery(input.query),
		...(input.operation.method === 'GET' ? {} : { body: input.body }),
		requestId: input.requestId,
		traceparent: input.traceparent,
		idempotencyKey: input.idempotencyKey,
		signal: input.signal,
	});
}
