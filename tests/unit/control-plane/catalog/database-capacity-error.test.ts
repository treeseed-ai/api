import { Context, Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createOperationHttpHandler } from '../../../../src/api/control-plane/http/operation-http-handler.ts';
import { controlPlaneErrorStatus } from '../../../../src/api/control-plane/catalog/operation-registry.ts';
import { CapacityOperationError } from '../../../../src/api/control-plane/repositories/capacity/capacity-operation-error.ts';
import { CapacityGovernanceError } from '../../../../src/api/capacity/database.ts';
import { createWorkdayService } from '../../../../src/api/control-plane/repositories/capacity/workday-service.ts';
import { createWorkdayOperations } from '../../../../src/api/control-plane/catalog/capacity/workdays.ts';
import { jsonError, jsonThrownError } from '../../../../src/api/app/support/foundation-safety.ts';

it('shared execution error serialization preserves supported statuses and the original cause without coercing malformed status authority', async () => {
	for (const status of [400, 401, 403, 404, 409, 412, 413, 422, 429, 500, 502, 503, undefined, null, '', '502', 0, 200, 501, 504, 502.5, NaN, Infinity, {}, []]) {
		const cause = Object.assign(new Error('Retained execution failure.'), { status, code: 'execution_failure', details: { attemptId: 'original-attempt' } });
		const held = { status, code: cause.code, message: cause.message, details: structuredClone(cause.details), stack: cause.stack };
		const response = jsonThrownError(new Context(new Request('http://localhost/execution')), cause);
		expect(response.status).toBe(controlPlaneErrorStatus(status));
		expect(await response.json()).toEqual({ ok: false, error: cause.message, code: cause.code, details: cause.details });
		expect({ status: cause.status, code: cause.code, message: cause.message, details: cause.details, stack: cause.stack }).toEqual(held);
		const direct = jsonError(new Context(new Request('http://localhost/execution')), status, 'Retained execution failure.');
		expect(direct.status).toBe(controlPlaneErrorStatus(status));
		expect(await direct.json()).toEqual({ ok: false, error: 'Retained execution failure.' });
	}
	expect(jsonThrownError(new Context(new Request('http://localhost/execution')), new Error('Unavailable.'), 503).status).toBe(503);
});

it('real Hono execution error boundaries retain denial history and exact successful retry without accepting malformed upstream statuses', async () => {
	const app = new Hono(), causes = [Object.assign(new Error('Original failed attempt.'), { status: '502', code: 'execution_failure', details: { attemptId: 'same-attempt' } }),
		Object.assign(new Error('Unavailable provider.'), { status: 503, code: 'provider_unavailable', details: { attemptId: 'same-attempt' } })];
	const held = causes.map(cause => ({ status: cause.status, code: cause.code, message: cause.message, details: structuredClone(cause.details), stack: cause.stack }));
	const requests: string[] = [], receipts: Array<{ status: number; body: unknown }> = [];
	app.onError((cause, context) => jsonThrownError(context, cause));
	app.post('/execution', async context => { requests.push(await context.req.text()); const cause = causes[requests.length - 1]; if (cause) throw cause;
		return context.json({ ok: true, attemptId: 'same-attempt' }); });
	const bytes = '{"attemptId":"same-attempt"}\n';
	for (const status of [500, 503, 200]) {
		const response = await app.request('/execution', { method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes });
		receipts.push({ status: response.status, body: await response.json() });
		expect(response.status).toBe(status);
	}
	expect(receipts).toEqual([{ status: 500, body: { ok: false, error: causes[0]?.message, code: 'execution_failure', details: { attemptId: 'same-attempt' } } },
		{ status: 503, body: { ok: false, error: causes[1]?.message, code: 'provider_unavailable', details: { attemptId: 'same-attempt' } } },
		{ status: 200, body: { ok: true, attemptId: 'same-attempt' } }]);
	expect(requests).toEqual([bytes, bytes, bytes]);
	expect(causes.map(cause => ({ status: cause.status, code: cause.code, message: cause.message, details: cause.details, stack: cause.stack }))).toEqual(held);
});

it('workday catalog retains supported governance failures and denies unsupported statuses without replacing the original cause', async () => {
	for (const status of [400, 401, 403, 404, 409, 412, 413, 422, 429, 500, 502, 503, 0, 200, 501, 504, NaN, Infinity]) {
		const cause = new CapacityGovernanceError('controlled_native_failure', 'Retained original cause.', status);
		const original = { status: cause.status, code: cause.code, message: cause.message, stack: cause.stack };
		const store = {
			principalCanAccessTeam: async () => true,
			getTeamAccessSummary: async () => ({ permissions: ['projects:read:team'] }),
			getCapacityWorkdayRun: async () => { throw cause; },
		};
		const operation = createWorkdayOperations({ workdays: createWorkdayService(store) })
			.find(candidate => candidate.binding.descriptor.operationId === CONTROL_PLANE_OPERATIONS.workdays.show.descriptor.operationId);
		if (!operation) throw new Error('Original workday public catalog binding required.');
		await expect(operation.handler({ path: { teamId: 'team', runId: 'run' }, query: {}, body: undefined },
			{ interface: 'internal', requestId: 'failure', principal: { id: 'test' } })).rejects.toMatchObject({
			status: controlPlaneErrorStatus(status), code: cause.code, message: cause.message,
		});
		expect({ status: cause.status, code: cause.code, message: cause.message, stack: cause.stack }).toEqual(original);
	}
});

it('preserves every supported capacity failure status including upstream bad gateway without coercing malformed authority', () => {
	for (const status of [400, 401, 403, 404, 409, 412, 413, 422, 429, 500, 502, 503]) {
		const error = new CapacityOperationError(status, 'capacity_upstream_failed', 'Original failed observation.');
		expect(controlPlaneErrorStatus(status)).toBe(status);
		expect(error).toMatchObject({ status, code: 'capacity_upstream_failed', message: 'Original failed observation.' });
	}
	for (const status of [undefined, null, '', '502', 0, 200, 501, 504, 502.5, NaN, Infinity, {}, []]) {
		expect(controlPlaneErrorStatus(status)).toBe(500);
	}
});

it('reports database exhaustion as an actionable unavailable response without exposing backend details', async () => {
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		const app = new Hono();
		app.post('/validate', createOperationHttpHandler({ binding: CONTROL_PLANE_OPERATIONS.seeds.validate,
			handler: async () => { throw Object.assign(new Error('private database connection details'), { code: '53300' }); },
		}, async () => ({ token: 'synthetic', clientId: 'test', scopes: ['treeseed:admin'],
			extra: { principal: { id: 'user', roles: ['platform_admin'], permissions: ['*:*:*'] } } }), 'digest'));
		const response = await app.request('/validate', { method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ bundle: { schemaVersion: 'treeseed.seed-bundle/v2', name: 'test' } }) });
		expect(response.status).toBe(503);
		const result = await response.json();
		expect(result.code).toBe('database_capacity_unavailable');
		expect(result.detail).toContain('connection budget');
		expect(result.requestId).toBeTruthy();
		expect(JSON.stringify(result)).not.toContain('private database connection details');
	} finally { log.mockRestore(); }
});
