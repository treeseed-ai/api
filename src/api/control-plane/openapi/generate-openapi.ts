import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BoundOperation, OperationRegistry } from '../catalog/operation-registry.ts';

function jsonSchema(operation: BoundOperation, direction: 'input' | 'output') {
	return z.toJSONSchema(direction === 'input' ? operation.inputSchema : operation.outputSchema, { target: 'draft-2020-12' });
}

export function generateOpenApi(registry: OperationRegistry, serverUrl = 'http://127.0.0.1:3002') {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const operation of registry.operations.values()) {
		if (!operation.descriptor.rest) continue;
		const rest = operation.descriptor.rest;
		const path = rest.path.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, '{$1}');
		paths[path] ??= {};
		paths[path]![rest.method.toLowerCase()] = {
			operationId: operation.descriptor.operationId,
			description: operation.descriptor.description,
			tags: [operation.descriptor.operationId.split('.')[0]],
			security: operation.descriptor.oauthScopes.length > 0 ? [{ oauth: operation.descriptor.oauthScopes }] : [],
			...(operation.descriptor.kind === 'mutation' ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(operation, 'input') } } } } : {}),
			responses: {
				'200': { description: 'Successful operation', content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: jsonSchema(operation, 'output'), meta: { type: 'object' }, links: { type: 'object' } } } } } },
				'default': { $ref: '#/components/responses/Problem' },
			},
		};
	}
	const scopes = ['treeseed:read', 'treeseed:knowledge:write', 'treeseed:governance:write', 'treeseed:projects:write', 'treeseed:execution', 'treeseed:admin'];
	return {
		openapi: '3.1.1',
		info: { title: 'TreeSeed Control Plane', version: '0.8.0-rc.1' },
		servers: [{ url: serverUrl }],
		paths,
		components: {
			securitySchemes: { oauth: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: `${serverUrl}/oauth/authorize`, tokenUrl: `${serverUrl}/oauth/token`, scopes: Object.fromEntries(scopes.map((scope) => [scope, scope])) } } } },
			responses: { Problem: { description: 'RFC 9457 problem', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } } },
			schemas: { Problem: { type: 'object', required: ['type', 'title', 'status', 'code'], properties: { type: { type: 'string', format: 'uri-reference' }, title: { type: 'string' }, status: { type: 'integer' }, detail: { type: 'string' }, instance: { type: 'string', format: 'uri-reference' }, code: { type: 'string' }, requestId: { type: 'string' }, traceId: { type: 'string' } } } },
		},
	};
}

export function openApiDigest(document: unknown) {
	return `sha256:${createHash('sha256').update(JSON.stringify(document)).digest('hex')}`;
}
