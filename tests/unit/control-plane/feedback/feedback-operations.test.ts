import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createFeedbackOperations } from '../../../../src/api/control-plane/catalog/feedback/index.ts';
import { OperationRegistry } from '../../../../src/api/control-plane/catalog/operation-registry.ts';
import { createFeedbackOperationService } from '../../../../src/api/control-plane/feedback/feedback-operation-service.ts';
import { installControlPlaneProtocolRoutes } from '../../../../src/api/control-plane/http/protocol-routes.ts';

describe('feedback catalog operations', () => {
	it('binds the four retained SDK-owned feedback operations', () => {
		const operations = createFeedbackOperations({ feedback: {} as any });
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.feedback.create,
			CONTROL_PLANE_OPERATIONS.feedback.list,
			CONTROL_PLANE_OPERATIONS.feedback.show,
			CONTROL_PLANE_OPERATIONS.feedback.updateStatus,
		]);
	});

	it('requires an authenticated principal for feedback submission', async () => {
		const service = createFeedbackOperationService({});
		await expect(service.create(undefined, {}, 'feedback-request-1234')).rejects.toMatchObject({ status: 401, code: 'authentication_required' });
	});

	it('authenticates feedback without requiring an unrelated coarse OAuth scope', async () => {
		const feedback = { async create(principal: any) { return { id: 'feedback-1', principalId: principal?.id }; } } as any;
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, async (token) => token === 'feedback-token' ? {
			principal: { id: 'user-1', scopes: [], roles: [], permissions: [] }, credential: { id: 'client-1' },
		} : null, undefined, new OperationRegistry(createFeedbackOperations({ feedback })));
		const request = (authorization?: string) => app.request('/v1/feedback', { method: 'POST', headers: {
			'content-type': 'application/json', 'idempotency-key': 'feedback-request-1234', ...(authorization ? { authorization } : {}),
		}, body: '{}' });
		expect((await request()).status).toBe(401);
		const accepted = await request('Bearer feedback-token');
		expect(accepted.status).toBe(200);
		expect(await accepted.json()).toEqual({ data: { id: 'feedback-1', principalId: 'user-1' } });
	});

	it('requires platform feedback authority for administration', async () => {
		const service = createFeedbackOperationService({});
		await expect(service.list({ id: 'user-1', permissions: [], roles: [] }, {})).rejects.toMatchObject({ status: 403, code: 'feedback_admin_forbidden' });
	});
});
