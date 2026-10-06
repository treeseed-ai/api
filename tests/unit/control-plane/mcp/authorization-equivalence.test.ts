import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { OperationRegistry } from '../../../../src/api/control-plane/catalog/operation-registry.ts';
import { installControlPlaneProtocolRoutes } from '../../../../src/api/control-plane/http/protocol-routes.ts';
import { sdkOperationInputStandardSchema, sdkSchemaJson, sdkStandardSchema } from '../../../../src/api/control-plane/catalog/sdk-standard-schema.ts';

describe('MCP authorization equivalence', () => {
	it('keeps provider and workday Standard Schema projections exact while native validation denies caller derived authority', () => {
		const binding = CONTROL_PLANE_OPERATIONS.workdays.preflight, descriptor = structuredClone(binding.descriptor);
		const expected = { type: 'object', properties: { teamId: { type: 'string', minLength: 1 } }, required: ['teamId'], additionalProperties: false };
		expect(sdkSchemaJson(binding.schema.path)).toEqual(expected);
		const path = sdkStandardSchema(binding.schema.path)['~standard'];
		expect(path.jsonSchema.input()).toEqual(expected); expect(path.jsonSchema.output()).toEqual(expected);
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
				requestHeaders.set('host', 'localhost'); return app.fetch(new Request(request, { headers: requestHeaders }));
			},
		});
		const client = new Client({ name: 'workday-schema-consumer', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
		try {
			await client.connect(transport);
			expect(await client.callTool({ name: binding.descriptor.operationId, arguments: { path: { teamId: 'native-team' }, body } }))
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
