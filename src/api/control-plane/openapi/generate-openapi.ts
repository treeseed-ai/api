import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BoundOperation, OperationRegistry } from '../catalog/operation-registry.ts';
import { sdkSchemaJson } from '../catalog/sdk-standard-schema.ts';

const apiVersion = String(JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')).version);

function jsonSchema(operation: BoundOperation, direction: 'input' | 'output') {
	const schema = direction === 'output' ? operation.binding.schema.output : operation.binding.schema.body;
	return sdkSchemaJson(schema);
}

function parameters(operation: BoundOperation) {
	const descriptor = operation.binding.descriptor;
	if (!descriptor.rest) return [];
	const requiredPath = new Set([...descriptor.rest.path.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)].map((match) => match[1]));
	const path = sdkSchemaJson(operation.binding.schema.path) as { properties?: Record<string, unknown> };
	const query = sdkSchemaJson(operation.binding.schema.query) as { properties?: Record<string, unknown>; required?: string[] };
	const requiredQuery = new Set(query.required ?? []);
	return [
		...[...requiredPath].map((name) => ({ name, in: 'path', required: true, schema: path.properties?.[name] ?? { type: 'string' } })),
		...Object.entries(query.properties ?? {}).map(([name, schema]) => ({ name, in: 'query', required: requiredQuery.has(name), schema })),
	];
}

export function generateOpenApi(registry: OperationRegistry, serverUrl = 'http://127.0.0.1:3002') {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const operation of registry.operations.values()) {
		const descriptor = operation.binding.descriptor;
		if (!descriptor.rest) continue;
		const rest = descriptor.rest;
		const path = rest.path;
		paths[path] ??= {};
		paths[path]![rest.method.toLowerCase()] = {
			operationId: descriptor.operationId,
			description: descriptor.description,
			tags: [descriptor.operationId.split('.')[0]],
			security: descriptor.authentication === 'oauth' ? [{ oauth: descriptor.oauthScopes }]
				: descriptor.authentication === 'oauth_or_provider' ? [{ oauth: descriptor.oauthScopes }, { providerProtocol: [] }]
				: descriptor.authentication === 'provider' ? [{ providerProtocol: [] }] : [],
			parameters: parameters(operation),
			...(descriptor.kind === 'mutation' ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(operation, 'input') } } } } : {}),
			responses: {
				'200': { description: 'Successful operation', content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: jsonSchema(operation, 'output'), meta: { type: 'object' }, links: { type: 'object' } } } } } },
				'default': { $ref: '#/components/responses/Problem' },
			},
		};
	}
	return {
		openapi: '3.1.1',
		info: { title: 'TreeSeed Control Plane', version: apiVersion },
		servers: [{ url: serverUrl }],
		paths,
		components: {
			securitySchemes: {
				oauth: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'opaque',
					description: `Discover current OAuth capabilities at ${serverUrl}/.well-known/oauth-authorization-server.`,
				},
				providerProtocol: {
					type: 'apiKey', in: 'header', name: 'Authorization',
					description: 'TreeSeed provider registration, credential, or provider bearer authorization as required by the selected provider operation.',
				},
			},
			responses: { Problem: { description: 'RFC 9457 problem', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } } },
			schemas: { Problem: { type: 'object', required: ['type', 'title', 'status', 'code'], properties: { type: { type: 'string', format: 'uri-reference' }, title: { type: 'string' }, status: { type: 'integer' }, detail: { type: 'string' }, instance: { type: 'string', format: 'uri-reference' }, code: { type: 'string' }, requestId: { type: 'string' }, traceId: { type: 'string' } } } },
		},
	};
}

export function openApiDigest(document: unknown) {
	return `sha256:${createHash('sha256').update(JSON.stringify(document)).digest('hex')}`;
}
