import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { CONTROL_PLANE_OPERATIONS, type ControlPlaneOperationBinding } from '@treeseed/sdk/operator-contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v3';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Hono } from 'hono';
import { OperationRegistry } from '../../../../src/api/control-plane/catalog/operation-registry.ts';
import { installControlPlaneProtocolRoutes } from '../../../../src/api/control-plane/http/protocol-routes.ts';
import { sdkOperationInputStandardSchema, sdkSchemaJson, sdkStandardSchema } from '../../../../src/api/control-plane/catalog/sdk-standard-schema.ts';

function bindings(value: unknown): ControlPlaneOperationBinding[] {
	if (!value || typeof value !== 'object') return [];
	if ('descriptor' in value && 'schema' in value) return [value as ControlPlaneOperationBinding];
	return Object.values(value).flatMap(bindings);
}

describe('MCP JSON Schema dialect', () => {
	it('advertises and validates the canonical body for read-only POST planning', () => {
		const binding = CONTROL_PLANE_OPERATIONS.agents.teamClone.plan;
		const schema = sdkOperationInputStandardSchema(binding)['~standard'];
		const body = { sourceProject: 'api', targetProjects: ['admin'] };
		expect(schema.jsonSchema.input().properties).toHaveProperty('body');
		expect(schema.validate({ path: { teamId: 'team' }, body })).toEqual({ value: { path: { teamId: 'team' }, query: {}, body } });
		for (const invalid of [undefined, {}, { sourceProject: 'api' }, { ...body, allEligible: true }, { ...body, unexpected: true }])
			expect(schema.validate({ path: { teamId: 'team' }, body: invalid })).toHaveProperty('issues');
		expect(schema.jsonSchema.input().properties).not.toHaveProperty('headers');
	});
	it('delivers read-only POST input through the official MCP client and shared HTTP adapter', async () => {
		const binding = CONTROL_PLANE_OPERATIONS.agents.teamClone.plan, calls: unknown[] = [];
		const body = { sourceProject: 'api', targetProjects: ['admin'] };
		const project = { projectId: 'api', name: 'API', slug: 'api', repository: 'api-library', commit: 'a'.repeat(40) };
		const plan = { schemaVersion: 'treeseed.agent-team-clone-plan/v1', teamId: 'team', source: project,
			targets: [{ ...project, projectId: 'admin', action: 'noop', definitions: [{ path: 'agents/engineer.yaml',
				agentClass: 'engineer', sourceDigest: `sha256:${'b'.repeat(64)}`, desiredDigest: `sha256:${'b'.repeat(64)}` }] }], digest: `sha256:${'c'.repeat(64)}` };
		const registry = new OperationRegistry([{ binding, handler: async input => { calls.push(input.body); return plan; } }]);
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, async () => ({ principal: { id: 'user', scopes: ['treeseed:read'] }, credential: { id: 'client' } }), undefined, registry);
		const client = new Client({ name: 'read-plan-input', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
		try {
			await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
				authProvider: { token: async () => 'controlled-principal' }, fetch: async (input, init) => {
					const request = input instanceof Request ? input : new Request(input, init), headers = new Headers(request.headers);
					headers.set('host', 'localhost'); return app.fetch(new Request(request, { headers }));
				},
			}));
			const tools = await client.listTools();
			expect(tools.tools[0]!.inputSchema.properties).toHaveProperty('body');
			const result = await client.callTool({ name: binding.descriptor.operationId, arguments: { path: { teamId: 'team' }, body } });
			expect(result.isError).not.toBe(true); expect(result.structuredContent).toEqual(plan); expect(calls).toEqual([body]);
			const denied = await client.callTool({ name: binding.descriptor.operationId, arguments: { path: { teamId: 'team' }, body: { ...body, allEligible: true } } });
			expect(denied.isError).toBe(true); expect(calls).toEqual([body]);
		} finally { await client.close(); }
	});
	it('compiles every declared MCP tool input and output with the official client validator', () => {
		const exposed = bindings(CONTROL_PLANE_OPERATIONS).filter(binding => binding.descriptor.surfaces.includes('mcp_tool'));
		expect(exposed.map(binding => binding.descriptor.operationId)).toEqual(expect.arrayContaining([
			'communications.send', 'agents.classes.list', 'agents.classes.show',
		]));
		const validator = new AjvJsonSchemaValidator(), failures: string[] = [];
		for (const binding of exposed) {
			for (const [kind, document] of [['input', sdkOperationInputStandardSchema(binding)['~standard'].jsonSchema.input()],
				['output', sdkStandardSchema(binding.schema.output)['~standard'].jsonSchema.output()]] as const) {
				try { validator.getValidator(document); }
				catch (error) { failures.push(`${binding.descriptor.operationId}.${kind}: ${String(error)}`); }
			}
		}
		expect(failures).toEqual([]);
	});
	it('preserves native numeric nullable tuple and strict object constraints without changing OpenAPI projection', () => {
		const schema = z.object({ positive: z.number().positive(), ceiling: z.number().lt(4), inclusive: z.number().min(2).max(3),
			optional: z.string().nullable(), pair: z.tuple([z.string(), z.number()]) }).strict();
		const document = sdkStandardSchema(schema)['~standard'].jsonSchema.output();
		const validate = new AjvJsonSchemaValidator().getValidator(document);
		const valid = { positive: 1, ceiling: 3, inclusive: 2, optional: null, pair: ['row', 2] };
		for (const value of [valid, { ...valid, optional: 'present' }, { ...valid, positive: 0 }, { ...valid, ceiling: 4 },
			{ ...valid, inclusive: 1 }, { ...valid, inclusive: 4 }, { ...valid, pair: [2, 'row'] }, { ...valid, unexpected: true }]) {
			expect(validate(value).valid).toBe(schema.safeParse(value).success);
		}
		expect(sdkSchemaJson(schema)).toMatchObject({ properties: { positive: { minimum: 0, exclusiveMinimum: true },
			optional: { type: 'string', nullable: true } } });
	});
});
