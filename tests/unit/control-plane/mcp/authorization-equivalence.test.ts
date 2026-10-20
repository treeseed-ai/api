import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ControlPlaneOperationError, OperationRegistry, type OperationInvocationContext } from '../../../../src/api/control-plane/catalog/operation-registry.ts';
import { installControlPlaneProtocolRoutes } from '../../../../src/api/control-plane/http/protocol-routes.ts';
import { sdkOperationInputStandardSchema, sdkSchemaJson, sdkStandardSchema } from '../../../../src/api/control-plane/catalog/sdk-standard-schema.ts';

describe('MCP authorization equivalence', () => {
	it('retains real MCP mutation identity and version headers and denies missing authority before dispatch', async () => {
		const binding = CONTROL_PLANE_OPERATIONS.projects.update;
		const observations: OperationInvocationContext[] = [];
		const registry = new OperationRegistry([{ binding, async handler(_input, context) {
			observations.push(context);
			if (context.ifMatch !== 'revision-1') throw new ControlPlaneOperationError(412, 'project_version_changed', 'Read the current project revision before updating it.');
			return { id: 'project-api', updatedAt: 'revision-2' };
		} }]);
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, async () => ({ principal: { id: 'coordinator', scopes: ['treeseed:projects:write'] },
			credential: { id: 'coordinator-client' } }), undefined, registry);
		let supplied: Record<string, string> = {};
		const client = new Client({ name: 'project-coordinator', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
		await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
			authProvider: { token: async () => 'controlled-coordinator-token' }, fetch: async (input, init) => {
				const request = input instanceof Request ? input : new Request(input, init), headers = new Headers(request.headers);
				headers.set('host', 'localhost');
				for (const [name, value] of Object.entries(supplied)) headers.set(name, value);
				return app.fetch(new Request(request, { headers }));
			},
		}));
		const arguments_ = { path: { projectId: 'project-api' }, body: { name: 'API coordinator work' } };
		try {
			const missingKey = await client.callTool({ name: binding.descriptor.operationId, arguments: arguments_ });
			expect(missingKey).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/Idempotency-Key/iu) }] });
			expect(observations).toEqual([]);
			supplied = { 'idempotency-key': 'api-objective-update' };
			const missingVersion = await client.callTool({ name: binding.descriptor.operationId, arguments: arguments_ });
			expect(missingVersion).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/If-Match/iu) }] });
			expect(observations).toEqual([]);
			supplied['if-match'] = '"revision-1"';
			const updated = await client.callTool({ name: binding.descriptor.operationId, arguments: arguments_ });
			expect(updated).toMatchObject({ structuredContent: { id: 'project-api', updatedAt: 'revision-2' } });
			expect(observations).toHaveLength(1);
			expect(observations[0]).toMatchObject({ interface: 'mcp', idempotencyKey: 'api-objective-update', ifMatch: 'revision-1',
				principal: { id: 'coordinator' } });
			supplied['if-match'] = '"revision-stale"';
			expect(await client.callTool({ name: binding.descriptor.operationId, arguments: arguments_ }))
				.toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/current project revision/iu) }] });
			expect(observations).toHaveLength(2);
			expect(observations[1]).toMatchObject({ idempotencyKey: 'api-objective-update', ifMatch: 'revision-stale' });
			const tool = (await client.listTools()).tools.find(value => value.name === binding.descriptor.operationId);
			expect(tool?.inputSchema).toHaveProperty('properties.headers.additionalProperties', false);
			supplied = {};
			const modelHeaders = { 'Idempotency-Key': 'model-api-objective-update', 'If-Match': '"revision-1"' };
			expect(await client.callTool({ name: binding.descriptor.operationId, arguments: { ...arguments_, headers: modelHeaders } }))
				.toMatchObject({ structuredContent: { id: 'project-api', updatedAt: 'revision-2' } });
			expect(observations[2]).toMatchObject({ idempotencyKey: 'model-api-objective-update', ifMatch: 'revision-1' });
			for (const headers of [{ ...modelHeaders, 'If-Match': '' }, { ...modelHeaders, 'Idempotency-Key': '  ' },
				{ ...modelHeaders, 'Idempotency-Key': 7 }, { ...modelHeaders, 'Idempotency-Key': 'key\r\ninjected' },
				...['Authorization', 'Cookie', 'x-treeseed-confirmation', 'x-treeseed-provider-proof', 'x-treeseed-assignment-id'].map(name => ({ ...modelHeaders, [name]: 'forbidden' })),
				[], null, 'not-headers']) {
				expect(await client.callTool({ name: binding.descriptor.operationId, arguments: { ...arguments_, headers } })).toMatchObject({ isError: true });
				expect(observations).toHaveLength(3);
			}
			supplied = { 'idempotency-key': 'different-host-request' };
			expect(await client.callTool({ name: binding.descriptor.operationId, arguments: { ...arguments_, headers: modelHeaders } }))
				.toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/conflicting.*Idempotency-Key/iu) }] });
			expect(observations).toHaveLength(3);
			supplied = { 'Idempotency-Key': ' model-api-objective-update ', 'If-Match': '  "revision-1"  ' };
			expect(await client.callTool({ name: binding.descriptor.operationId, arguments: { ...arguments_, headers: modelHeaders } }))
				.toMatchObject({ structuredContent: { id: 'project-api', updatedAt: 'revision-2' } });
			expect(observations[3]).toMatchObject({ idempotencyKey: 'model-api-objective-update', ifMatch: 'revision-1' });
			supplied = {};
			const parallel = ['first-model-request', 'second-model-request'].map(key => client.callTool({ name: binding.descriptor.operationId,
				arguments: { ...arguments_, headers: { ...modelHeaders, 'Idempotency-Key': key } } }));
			for (const result of await Promise.all(parallel)) expect(result).toMatchObject({ structuredContent: { id: 'project-api', updatedAt: 'revision-2' } });
			expect(observations.slice(4).map(value => value.idempotencyKey).sort()).toEqual(['first-model-request', 'second-model-request']);
		} finally { await client.close(); }
	});
	it('keeps provider and workday Standard Schema projections exact while native validation denies caller derived authority', () => {
		const binding = CONTROL_PLANE_OPERATIONS.workdays.preflight, descriptor = structuredClone(binding.descriptor);
		const expected = { type: 'object', properties: { teamId: { type: 'string', minLength: 1 } }, required: ['teamId'], additionalProperties: false };
		expect(sdkSchemaJson(binding.schema.path)).toEqual(expected);
		const path = sdkStandardSchema(binding.schema.path)['~standard'];
		const jsonSchema = { $schema: 'http://json-schema.org/draft-07/schema#', ...expected };
		expect(path.jsonSchema.input()).toEqual(jsonSchema); expect(path.jsonSchema.output()).toEqual(jsonSchema);
		expect(path.validate({ teamId: 'native-team' })).toEqual({ value: { teamId: 'native-team' } });
		expect(path.validate({ teamId: '' })).toMatchObject({ issues: [{ path: ['teamId'] }] });
		const input = { path: { teamId: 'native-team' }, query: {}, body: { profileId: 'arbitrary-profile', projects: ['sdk'],
			startsAt: '2026-10-06T00:00:00.000Z', durationSeconds: 60, decisionIds: ['exact-decision'] } }, held = structuredClone(input);
		const standard = sdkOperationInputStandardSchema(binding)['~standard'];
		expect(standard.jsonSchema.input()).toEqual(standard.jsonSchema.output());
		expect(standard.validate(input)).toEqual({ value: input });
		for (const field of ['executionPlanId', 'capacityPlanId', 'executionInputId', 'demandSetId']) {
			const invalid = { ...input, body: { ...input.body, [field]: 'caller-derived' } }, before = structuredClone(invalid);
			expect(standard.validate(invalid)).toHaveProperty('issues'); expect(invalid).toEqual(before);
		}
		expect(sdkStandardSchema(CONTROL_PLANE_OPERATIONS.providers.assignment.schema.path)['~standard'].validate({ assignmentId: '' })).toHaveProperty('issues');
		expect(input).toEqual(held); expect(binding.descriptor).toEqual(descriptor);
	});
	it('real REST and MCP workday protocol consumers retain exact parsed inputs and deny malformed intent before the controlled handler', async () => {
		const binding = CONTROL_PLANE_OPERATIONS.workdays.preflight, observations: unknown[] = [];
		const registry = new OperationRegistry([{ binding, async handler(input) {
			observations.push(structuredClone(input)); return { received: input.body };
		} }]);
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, async () => ({ principal: { id: 'user_1', scopes: ['treeseed:execution'], roles: [], permissions: [] },
			credential: { id: 'client_1' } }), undefined, registry);
		const body = { profileId: 'arbitrary-profile', projects: ['sdk'], startsAt: '2026-10-06T00:00:00.000Z', durationSeconds: 60,
			decisionIds: ['exact-decision'] }, held = structuredClone(body);
		const headers = { authorization: 'Bearer controlled-protocol-input', 'content-type': 'application/json' };
		const missingKey = await app.request('/v1/teams/native-team/workday-runs/preflight', { method: 'POST', headers, body: JSON.stringify(body) });
		expect(missingKey.status).toBe(400); expect(await missingKey.json()).toMatchObject({ code: 'idempotency_key_required' });
		expect(observations).toEqual([]);
		const validHeaders = { ...headers, 'Idempotency-Key': 'controlled-schema-consumer' };
		const valid = await app.request('/v1/teams/native-team/workday-runs/preflight', { method: 'POST', headers: validHeaders, body: JSON.stringify(body) });
		expect(valid.status).toBe(200); expect(await valid.json()).toMatchObject({ data: { received: body } });
		const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
			authProvider: { token: async () => 'controlled-protocol-input' }, fetch: async (input, init) => {
				const request = input instanceof Request ? input : new Request(input, init), requestHeaders = new Headers(request.headers);
				requestHeaders.set('host', 'localhost'); requestHeaders.set('Idempotency-Key', 'controlled-schema-consumer');
				return app.fetch(new Request(request, { headers: requestHeaders }));
			},
		});
		const client = new Client({ name: 'workday-schema-consumer', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
		try {
			await client.connect(transport);
			expect(await client.callTool({ name: binding.descriptor.operationId, arguments: { path: { teamId: 'native-team' }, body,
				headers: { 'Idempotency-Key': 'controlled-schema-consumer' } } }))
				.toMatchObject({ structuredContent: { received: body } });
			for (const invalid of [{ ...body, executionPlanId: 'caller-derived' }, { ...body, decisionIds: [] }, { ...body, decisionIds: ['é'] }]) {
				const before = structuredClone(invalid), count = observations.length;
				const denied = await app.request('/v1/teams/native-team/workday-runs/preflight', { method: 'POST', headers: validHeaders, body: JSON.stringify(invalid) });
				expect(denied.status).toBe(400); expect(await denied.json()).toMatchObject({ code: 'operation_input_invalid' });
				const result = await client.callTool({ name: binding.descriptor.operationId, arguments: { path: { teamId: 'native-team' }, body: invalid } });
				expect(result.isError).toBe(true); expect(observations).toHaveLength(count); expect(invalid).toEqual(before);
			}
			expect(observations).toEqual(Array.from({ length: 2 }, () => ({ path: { teamId: 'native-team' }, query: {}, body })));
			expect(body).toEqual(held);
		} finally { await client.close(); }
	});
	it('enforces the same catalog OAuth scope before REST and MCP handler invocation', async () => {
		let invocations = 0;
		const status = CONTROL_PLANE_OPERATIONS.status.show;
		const registry = new OperationRegistry([{
			binding: { ...status, descriptor: { ...status.descriptor, oauthScopes: ['treeseed:admin'] } },
			async handler() { invocations += 1; return { status: 'ok', mcpProtocolVersion: '2026-07-28' as const }; },
		}]);
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, async () => ({
			principal: { id: 'user_1', scopes: ['treeseed:read'], roles: [], permissions: [] }, credential: { id: 'client_1' },
		}), undefined, registry);
		const rest = await app.request('/v1/status', { headers: { authorization: 'Bearer test-token' } });
		expect(rest.status).toBe(403);
		expect(await rest.json()).toMatchObject({ code: 'oauth_scope_insufficient' });
		const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
			authProvider: { token: async () => 'test-token' },
			fetch: async (input, init) => {
				const request = input instanceof Request ? input : new Request(input, init);
				const headers = new Headers(request.headers);
				headers.set('host', 'localhost');
				return app.fetch(new Request(request, { headers }));
			},
		});
		const client = new Client({ name: 'scope-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
		await client.connect(transport);
		try {
			const toolResult = await client.callTool({ name: 'status.show', arguments: {} });
			expect(toolResult).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/treeseed:admin/iu) }] });
			await expect(client.readResource({ uri: 'treeseed://status' })).rejects.toThrow(/treeseed:admin|scope|request failed/iu);
		} finally {
			await client.close();
		}
		expect(invocations).toBe(0);
	});
});
