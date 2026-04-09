import crypto from 'node:crypto';
import { Hono } from 'hono';
import type { SdkQueueMessageEnvelope } from '@treeseed/sdk';
import { AgentSdk } from '@treeseed/sdk/sdk';
import type { GatewayServerOptions } from './types.ts';

function jsonError(c: any, status: number, error: string) {
	return c.json({ ok: false, error }, status);
}

function bearerTokenFromRequest(request: Request) {
	const header = request.headers.get('authorization');
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match?.[1] ?? null;
}

function queueEnvelopeForTask(task: Record<string, unknown>): SdkQueueMessageEnvelope {
	return {
		messageId: crypto.randomUUID(),
		taskId: String(task.id ?? ''),
		workDayId: String(task.workDayId ?? task.work_day_id ?? ''),
		agentId: String(task.agentId ?? task.agent_id ?? ''),
		taskType: String(task.type ?? ''),
		idempotencyKey: String(task.idempotencyKey ?? task.idempotency_key ?? ''),
		attempt: Number(task.attemptCount ?? task.attempt_count ?? 0) + 1,
		payloadRef: `d1:tasks/${String(task.id ?? '')}`,
		graphVersion:
			task.graphVersion !== undefined && task.graphVersion !== null
				? String(task.graphVersion)
				: task.graph_version !== undefined && task.graph_version !== null
					? String(task.graph_version)
					: null,
		budgetHint: 1,
	};
}

export function createTreeseedGatewayApp(options: GatewayServerOptions) {
	const sdk = options.sdk instanceof AgentSdk ? options.sdk : new AgentSdk();
	const app = new Hono();

	app.use('*', async (c, next) => {
		const token = bearerTokenFromRequest(c.req.raw);
		if (token !== options.bearerToken) {
			return jsonError(c, 401, 'Unauthorized gateway request.');
		}
		await next();
	});

	app.get('/healthz', (c) => c.json({ ok: true, service: 'treeseed-agent-gateway' }));

	app.post('/workdays/start', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const result = await sdk.startWorkDay({
			id: typeof body.id === 'string' ? body.id : undefined,
			projectId: String(body.projectId ?? options.projectId ?? 'treeseed-market'),
			capacityBudget: Number(body.capacityBudget ?? 0),
			graphVersion: typeof body.graphVersion === 'string' ? body.graphVersion : null,
			summary: (body.summary as Record<string, unknown> | undefined) ?? null,
			actor: String(body.actor ?? 'gateway'),
		});
		return c.json(result);
	});

	app.post('/workdays/:id/close', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const result = await sdk.closeWorkDay({
			id: c.req.param('id'),
			state: body.state,
			summary: (body.summary as Record<string, unknown> | undefined) ?? null,
			actor: String(body.actor ?? 'gateway'),
		});
		return result ? c.json(result) : jsonError(c, 404, 'Unknown work day.');
	});

	app.post('/tasks', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const result = await sdk.createTask({
			id: typeof body.id === 'string' ? body.id : undefined,
			workDayId: String(body.workDayId ?? ''),
			agentId: String(body.agentId ?? ''),
			type: String(body.type ?? ''),
			state: typeof body.state === 'string' ? body.state : 'pending',
			priority: Number(body.priority ?? 0),
			idempotencyKey: String(body.idempotencyKey ?? ''),
			payload: (body.payload as Record<string, unknown> | undefined) ?? {},
			payloadHash: typeof body.payloadHash === 'string' ? body.payloadHash : null,
			maxAttempts: Number(body.maxAttempts ?? 3),
			availableAt: typeof body.availableAt === 'string' ? body.availableAt : undefined,
			graphVersion: typeof body.graphVersion === 'string' ? body.graphVersion : null,
			parentTaskId: typeof body.parentTaskId === 'string' ? body.parentTaskId : null,
			actor: String(body.actor ?? 'gateway'),
		});
		return c.json(result);
	});

	app.post('/tasks/:id/claim', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const result = await sdk.claimTask({
			id: c.req.param('id'),
			workerId: String(body.workerId ?? 'worker'),
			leaseSeconds: Number(body.leaseSeconds ?? 120),
			actor: String(body.actor ?? 'gateway'),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown task.');
	});

	app.post('/tasks/:id/progress', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const result = await sdk.recordTaskProgress({
			id: c.req.param('id'),
			workerId: typeof body.workerId === 'string' ? body.workerId : null,
			state: typeof body.state === 'string' ? body.state : undefined,
			appendEvent: body.appendEvent as { kind: string; data?: Record<string, unknown> } | undefined,
			patch: body.patch as Record<string, unknown> | undefined,
			actor: String(body.actor ?? 'gateway'),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown task.');
	});

	app.post('/tasks/:id/complete', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const result = await sdk.completeTask({
			id: c.req.param('id'),
			output: (body.output as Record<string, unknown> | undefined) ?? null,
			outputRef: typeof body.outputRef === 'string' ? body.outputRef : null,
			summary: (body.summary as Record<string, unknown> | undefined) ?? null,
			actor: String(body.actor ?? 'gateway'),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown task.');
	});

	app.post('/tasks/:id/fail', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const result = await sdk.failTask({
			id: c.req.param('id'),
			errorCode: typeof body.errorCode === 'string' ? body.errorCode : null,
			errorMessage: String(body.errorMessage ?? 'Task failed'),
			retryable: Boolean(body.retryable),
			nextVisibleAt: typeof body.nextVisibleAt === 'string' ? body.nextVisibleAt : null,
			actor: String(body.actor ?? 'gateway'),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown task.');
	});

	app.post('/tasks/:id/requeue', async (c) => {
		const task = await sdk.get({ model: 'task', id: c.req.param('id') });
		if (!task.payload) {
			return jsonError(c, 404, 'Unknown task.');
		}
		if (!options.queueProducer) {
			return jsonError(c, 501, 'Queue producer not configured.');
		}
		const body = await c.req.json().catch(() => ({}));
		await options.queueProducer.enqueue({
			queueName: typeof body.queueName === 'string' ? body.queueName : undefined,
			message: queueEnvelopeForTask(task.payload as Record<string, unknown>),
			delaySeconds: Number(body.delaySeconds ?? 0),
		});
		return c.json({ ok: true, taskId: c.req.param('id'), queued: true });
	});

	app.post('/queue/enqueue', async (c) => {
		if (!options.queueProducer) {
			return jsonError(c, 501, 'Queue producer not configured.');
		}
		const body = await c.req.json().catch(() => ({}));
		const taskId = String(body.taskId ?? '');
		const task = await sdk.get({ model: 'task', id: taskId });
		if (!task.payload) {
			return jsonError(c, 404, 'Unknown task.');
		}
		await options.queueProducer.enqueue({
			queueName: typeof body.queueName === 'string' ? body.queueName : undefined,
			message: queueEnvelopeForTask(task.payload as Record<string, unknown>),
			delaySeconds: Number(body.deliveryDelaySeconds ?? 0),
		});
		await sdk.recordTaskProgress({
			id: taskId,
			state: 'queued',
			appendEvent: { kind: 'queued', data: { queueName: body.queueName ?? null } },
			actor: String(body.actor ?? 'gateway'),
		});
		return c.json({ ok: true, taskId, queued: true });
	});

	app.post('/reports', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const result = await sdk.createReport({
			id: typeof body.id === 'string' ? body.id : undefined,
			workDayId: String(body.workDayId ?? ''),
			kind: String(body.kind ?? 'workday_summary'),
			body: (body.body as Record<string, unknown> | undefined) ?? {},
			renderedRef: typeof body.renderedRef === 'string' ? body.renderedRef : null,
			sentAt: typeof body.sentAt === 'string' ? body.sentAt : null,
			actor: String(body.actor ?? 'gateway'),
		});
		return c.json(result);
	});

	return app;
}
