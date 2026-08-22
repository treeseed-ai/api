import { createHash } from 'node:crypto';
import type { BoundOperation, OperationRegistry } from '../catalog/operation-registry.ts';
import { sdkSchemaJson } from '../catalog/sdk-standard-schema.ts';

function jsonSchema(operation: BoundOperation, direction: 'input' | 'output') {
	const schema = direction === 'output' ? operation.binding.schema.output : operation.binding.schema.body;
	return sdkSchemaJson(schema);
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
				: descriptor.authentication === 'provider' ? [{ providerProtocol: [] }] : [],
			...(descriptor.kind === 'mutation' ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(operation, 'input') } } } } : {}),
			responses: {
				'200': { description: 'Successful operation', content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: jsonSchema(operation, 'output'), meta: { type: 'object' }, links: { type: 'object' } } } } } },
				'default': { $ref: '#/components/responses/Problem' },
			},
		};
	}
	return {
		openapi: '3.1.1',
		info: { title: 'TreeSeed Control Plane', version: '0.8.0-rc.1' },
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
