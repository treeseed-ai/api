import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { AUTH_SCHEMA_SQL } from '../../../../src/api/auth/postgres-store.ts';
import { createCommunicationOperations } from '../../../../src/api/control-plane/catalog/capacity/communications.ts';
import { OperationRegistry } from '../../../../src/api/control-plane/catalog/operation-registry.ts';
import { ConfirmationService } from '../../../../src/api/control-plane/confirmation/confirmation-service.ts';
import { installControlPlaneProtocolRoutes } from '../../../../src/api/control-plane/http/protocol-routes.ts';
import { createCommunicationService } from '../../../../src/api/control-plane/repositories/capacity/communication-service.ts';
import { ControlPlaneStore } from '../../../../src/api/persistence/store.ts';
import { postgresGraph } from '../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';

// Native MCP, owning catalog/service, and separate PostgreSQL read-back. The
// authenticated operator is a controlled input; no provider assignment is made.
it('native MCP cancels only the inspected queued project discussion and retains its exact request identity in PostgreSQL', async () => {
	const f = await postgresGraph();
	const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, f.left);
	store.initializationPromise = Promise.resolve();
	const at = '2026-10-19T12:00:00.000Z';
	const principal = { id: 'coordinator', roles: ['admin'], scopes: ['treeseed:read', 'treeseed:execution'] };
	const confirmations = new ConfirmationService('disposable-native-confirmation-key', { async consume(nonce, claims) {
		await store.run(`INSERT INTO operation_confirmation_nonces (nonce,principal_id,client_id,operation_id,arguments_digest,expires_at,consumed_at)
			VALUES (?,?,?,?,?,?,?)`, [nonce, claims.principalId, claims.clientId, claims.operationId, claims.argumentsDigest, claims.expiresAt, new Date().toISOString()]);
		return true;
	} });
	const app = new Hono();
	installControlPlaneProtocolRoutes(app, async () => ({ principal, credential: { id: 'project-coordinator-client' } }), undefined,
		new OperationRegistry(createCommunicationOperations({ communications: createCommunicationService(store) })), confirmations);
	const headers: Record<string, string> = {};
	const client = new Client({ name: 'project-coordinator', version: '1' }, { capabilities: { elicitation: { form: {} } },
		versionNegotiation: { mode: { pin: '2026-07-28' } }, inputRequired: { autoFulfill: true, maxRounds: 2 } });
	client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { confirm: true } }));
	const rows = async () => (await f.right.pool.query('SELECT * FROM agent_invocation_requests ORDER BY id')).rows;
	try {
		for (const sql of AUTH_SCHEMA_SQL.filter(value => value.includes('operation_confirmation_nonces'))) await f.left.pool.query(sql);
		await f.left.pool.query("INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('api','team','api','API',$1,$1)", [at]);
		await f.left.pool.query(`INSERT INTO agent_invocation_requests
			(id,team_id,project_id,agent_id,execution_kind,scope_hash,prompt,available_at,idempotency_key,request_digest,requested_at,updated_at)
			VALUES ('research','team','api','researcher','conversation','project-api','Review MCP retry recovery',$1,'original-send','original-message',$1,$1)`, [at]);
		await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
			authProvider: { token: async () => 'controlled-native-operator' }, fetch: async (input, init) => {
				const request = input instanceof Request ? input : new Request(input, init), supplied = new Headers(request.headers);
				supplied.set('host', 'localhost'); for (const [name, value] of Object.entries(headers)) supplied.set(name, value);
				return app.fetch(new Request(request, { headers: supplied }));
			},
		}));
		const call = () => client.callTool({ name: 'communications.invocations.cancel', arguments: {
			path: { teamId: 'team', invocationId: 'research' }, body: { reason: 'The coordinator consolidated this review into the approved proposal.' },
		} });
		const before = await rows();
		for (const supplied of [{}, { 'Idempotency-Key': 'cancel-api-research' }, { 'Idempotency-Key': 'cancel-api-research', 'If-Match': 'stale' }]) {
			Object.assign(headers, supplied);
			expect(await call()).toMatchObject({ isError: true }); expect(await rows()).toEqual(before);
		}
		headers['If-Match'] = `"${at}"`;
		expect(await call()).toMatchObject({ structuredContent: { id: 'research', status: 'cancelled' } });
		const after = await rows(); expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({ status: 'cancelled', idempotency_key: 'original-send',
			blocking_state_json: JSON.stringify({ code: 'operator_cancelled', idempotencyKey: 'cancel-api-research',
				reason: 'The coordinator consolidated this review into the approved proposal.' }) });
		const readback = await app.request('/v1/teams/team/agent-invocations/research', { headers: { authorization: 'Bearer controlled-native-operator' } });
		expect(readback.status).toBe(200); expect(await readback.json()).toMatchObject({ data: { id: 'research', status: 'cancelled' } });
		headers['If-Match'] = String(after[0]!.updated_at);
		expect(await call()).toMatchObject({ structuredContent: { id: 'research', status: 'cancelled', replayed: true } });
		expect(await rows()).toEqual(after);
		expect((await f.right.pool.query('SELECT * FROM capacity_provider_assignments')).rows).toEqual([]);
	} finally { await client.close(); await f.close(); }
}, 30_000);
