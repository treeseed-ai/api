import crypto from 'node:crypto';
import type { Hono } from 'hono';
import type {
	AgentSdk,
	SdkEnqueueTaskRequest,
	SdkQueueMessageEnvelope,
	SdkTaskEntity,
} from '@treeseed/sdk';
import { jsonError, requireScope } from './http.ts';
import type {
	AppVariables,
	GatewayQueueProducer,
} from './types.ts';

interface RegisterAgentRoutesOptions {
	sdk: AgentSdk;
	prefix?: string;
	scope?: string | null;
	projectId?: string;
	queueProducer?: GatewayQueueProducer;
	defaultActor?: string;
}

async function listRegisteredHandlers() {
	try {
		const agent = await import('@treeseed/agent');
		return agent.listRegisteredAgentHandlers();
	} catch {
		return [];
	}
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

function withPrefix(prefix: string, path: string) {
	return `${prefix}${path}`.replace(/\/{2,}/g, '/');
}

function actor(body: Record<string, unknown>, fallback: string) {
	return String(body.actor ?? fallback);
}

async function enqueueTask(
	options: RegisterAgentRoutesOptions,
	request: SdkEnqueueTaskRequest,
) {
	if (!options.queueProducer) {
		throw new Error('Queue producer not configured.');
	}
	const task = await options.sdk.get({ model: 'task', id: request.taskId });
	if (!task.payload) {
		throw new Error('Unknown task.');
	}
	await options.queueProducer.enqueue({
		queueName: request.queueName,
		message: queueEnvelopeForTask(task.payload as Record<string, unknown>),
		delaySeconds: request.deliveryDelaySeconds ?? 0,
	});
	await options.sdk.recordTaskProgress({
		id: request.taskId,
		state: 'queued',
		appendEvent: { kind: 'queued', data: { queueName: request.queueName ?? null } },
		actor: request.actor,
	});
	return { ok: true, taskId: request.taskId, queued: true };
}

async function buildTaskContext(sdk: AgentSdk, taskId: string) {
	const context = await sdk.getManagerContext(taskId);
	const task = context.payload.task;
	const agent = task
		? (await sdk.get({ model: 'agent', slug: String(task.agentId) })).payload
		: null;
	return {
		...context.payload,
		agent,
	};
}

export function registerAgentRoutes(
	app: Hono<{ Variables: AppVariables }>,
	options: RegisterAgentRoutesOptions,
) {
	const prefix = options.prefix ?? '/agent';
	const defaultActor = options.defaultActor ?? 'api';

	app.get(withPrefix(prefix, '/healthz'), async (c) => c.json({
		ok: true,
		service: 'treeseed-agent-api',
		handlerCount: (await listRegisteredHandlers()).length,
	}));

	app.get(withPrefix(prefix, '/specs'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const payload = await options.sdk.listAgentSpecs({ enabled: true });
		return c.json({
			ok: true,
			payload,
			handlers: await listRegisteredHandlers(),
		});
	});

	app.post(withPrefix(prefix, '/workdays/start'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const graphRefresh = await options.sdk.refreshGraph();
		const result = await options.sdk.startWorkDay({
			id: typeof body.id === 'string' ? body.id : undefined,
			projectId: String(body.projectId ?? options.projectId ?? 'treeseed-market'),
			capacityBudget: body.capacityBudget === undefined ? undefined : Number(body.capacityBudget),
			graphVersion: typeof body.graphVersion === 'string' ? body.graphVersion : graphRefresh.snapshotRoot,
			summary: (body.summary as Record<string, unknown> | undefined) ?? { graphRefresh },
			actor: actor(body, defaultActor),
		});
		return c.json(result);
	});

	app.post(withPrefix(prefix, '/workdays/:id/close'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.closeWorkDay({
			id: c.req.param('id'),
			state: body.state as 'completed' | 'cancelled' | 'failed' | undefined,
			summary: (body.summary as Record<string, unknown> | undefined) ?? null,
			actor: actor(body, defaultActor),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown work day.');
	});

	app.post(withPrefix(prefix, '/tasks'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.createTask({
			id: typeof body.id === 'string' ? body.id : undefined,
			workDayId: String(body.workDayId ?? ''),
			agentId: String(body.agentId ?? ''),
			type: String(body.type ?? ''),
			state: typeof body.state === 'string' ? body.state : 'pending',
			priority: body.priority === undefined ? undefined : Number(body.priority),
			idempotencyKey: String(body.idempotencyKey ?? ''),
			payload: (body.payload as Record<string, unknown> | undefined) ?? {},
			payloadHash: typeof body.payloadHash === 'string' ? body.payloadHash : null,
			maxAttempts: body.maxAttempts === undefined ? undefined : Number(body.maxAttempts),
			availableAt: typeof body.availableAt === 'string' ? body.availableAt : undefined,
			graphVersion: typeof body.graphVersion === 'string' ? body.graphVersion : null,
			parentTaskId: typeof body.parentTaskId === 'string' ? body.parentTaskId : null,
			actor: actor(body, defaultActor),
		});
		return c.json(result);
	});

	app.post(withPrefix(prefix, '/tasks/search'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.searchTasks({
			workDayId: typeof body.workDayId === 'string' ? body.workDayId : undefined,
			agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
			state: Array.isArray(body.state) || typeof body.state === 'string' ? body.state as string | string[] : undefined,
			limit: body.limit === undefined ? undefined : Number(body.limit),
		});
		return c.json(result);
	});

	app.post(withPrefix(prefix, '/tasks/:id/claim'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.claimTask({
			id: c.req.param('id'),
			workerId: String(body.workerId ?? 'worker'),
			leaseSeconds: Number(body.leaseSeconds ?? 120),
			actor: actor(body, defaultActor),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown task.');
	});

	app.post(withPrefix(prefix, '/tasks/:id/progress'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.recordTaskProgress({
			id: c.req.param('id'),
			workerId: typeof body.workerId === 'string' ? body.workerId : null,
			state: typeof body.state === 'string' ? body.state : undefined,
			appendEvent: body.appendEvent as { kind: string; data?: Record<string, unknown> } | undefined,
			patch: body.patch as Record<string, unknown> | undefined,
			actor: actor(body, defaultActor),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown task.');
	});

	app.post(withPrefix(prefix, '/tasks/:id/complete'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.completeTask({
			id: c.req.param('id'),
			output: (body.output as Record<string, unknown> | undefined) ?? null,
			outputRef: typeof body.outputRef === 'string' ? body.outputRef : null,
			summary: (body.summary as Record<string, unknown> | undefined) ?? null,
			actor: actor(body, defaultActor),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown task.');
	});

	app.post(withPrefix(prefix, '/tasks/:id/fail'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.failTask({
			id: c.req.param('id'),
			errorCode: typeof body.errorCode === 'string' ? body.errorCode : null,
			errorMessage: String(body.errorMessage ?? 'Task failed'),
			retryable: Boolean(body.retryable),
			nextVisibleAt: typeof body.nextVisibleAt === 'string' ? body.nextVisibleAt : null,
			actor: actor(body, defaultActor),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown task.');
	});

	app.post(withPrefix(prefix, '/tasks/:id/requeue'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		try {
			return c.json(await enqueueTask(options, {
				taskId: c.req.param('id'),
				queueName: typeof body.queueName === 'string' ? body.queueName : undefined,
				deliveryDelaySeconds: body.delaySeconds === undefined ? undefined : Number(body.delaySeconds),
				actor: actor(body, defaultActor),
			}));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return jsonError(c, /Unknown task/.test(message) ? 404 : /Queue producer/.test(message) ? 501 : 500, message);
		}
	});

	app.post(withPrefix(prefix, '/tasks/:id/followups'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const current = await options.sdk.get({ model: 'task', id: c.req.param('id') });
		if (!current.payload) {
			return jsonError(c, 404, 'Unknown task.');
		}
		const currentTask = current.payload as SdkTaskEntity & Record<string, unknown>;
		const followups = Array.isArray(body.followups) ? body.followups : [];
		const created = [];
		for (const followup of followups as Array<Record<string, unknown>>) {
			created.push(await options.sdk.createTask({
				workDayId: String(followup.workDayId ?? currentTask.workDayId ?? ''),
				agentId: String(followup.agentId ?? currentTask.agentId ?? ''),
				type: String(followup.type ?? 'followup'),
				priority: followup.priority === undefined ? undefined : Number(followup.priority),
				idempotencyKey: String(followup.idempotencyKey ?? `${c.req.param('id')}:${created.length}`),
				payload: (followup.payload as Record<string, unknown> | undefined) ?? {},
				graphVersion: typeof followup.graphVersion === 'string' ? followup.graphVersion : null,
				parentTaskId: c.req.param('id'),
				actor: actor(followup, defaultActor),
			}));
		}
		return c.json({ ok: true, payload: created.map((entry) => entry.payload) });
	});

	app.post(withPrefix(prefix, '/queue/enqueue'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		try {
			return c.json(await enqueueTask(options, {
				taskId: String(body.taskId ?? ''),
				queueName: typeof body.queueName === 'string' ? body.queueName : undefined,
				deliveryDelaySeconds: body.deliveryDelaySeconds === undefined ? undefined : Number(body.deliveryDelaySeconds),
				actor: actor(body, defaultActor),
			}));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return jsonError(c, /Unknown task/.test(message) ? 404 : /Queue producer/.test(message) ? 501 : 500, message);
		}
	});

	app.post(withPrefix(prefix, '/reports'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.createReport({
			id: typeof body.id === 'string' ? body.id : undefined,
			workDayId: String(body.workDayId ?? ''),
			kind: String(body.kind ?? 'workday_summary'),
			body: (body.body as Record<string, unknown> | undefined) ?? {},
			renderedRef: typeof body.renderedRef === 'string' ? body.renderedRef : null,
			sentAt: typeof body.sentAt === 'string' ? body.sentAt : null,
			actor: actor(body, defaultActor),
		});
		return c.json(result);
	});

	app.post(withPrefix(prefix, '/context/resolve-task'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		return c.json({
			ok: true,
			payload: await buildTaskContext(options.sdk, String(body.taskId ?? '')),
		});
	});

	app.post(withPrefix(prefix, '/graph/search'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const query = String(body.query ?? '');
		const scope = String(body.scope ?? 'sections');
		const payload =
			scope === 'files'
				? await options.sdk.searchFiles(query, body.options as Record<string, unknown> | undefined)
				: scope === 'entities'
					? await options.sdk.searchEntities(query, body.options as Record<string, unknown> | undefined)
					: await options.sdk.searchSections(query, body.options as Record<string, unknown> | undefined);
		return c.json({ ok: true, payload });
	});

	app.post(withPrefix(prefix, '/graph/subgraph'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const payload = await options.sdk.getSubgraph(
			Array.isArray(body.seedIds) ? body.seedIds.map(String) : [],
			body.options as Record<string, unknown> | undefined,
		);
		return c.json({ ok: true, payload });
	});

	app.post(withPrefix(prefix, '/graph/query'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const payload = await options.sdk.queryGraph(body as never);
		if (typeof body.workDayId === 'string' && body.workDayId) {
			await options.sdk.create({
				model: 'graph_run',
				data: {
					workDayId: body.workDayId,
					corpusHash: String(body.corpusHash ?? 'query-graph'),
					graphVersion: String(body.graphVersion ?? ''),
					queryJson: JSON.stringify(body),
					seedIdsJson: JSON.stringify(payload.seedIds),
					selectedNodeIdsJson: JSON.stringify(payload.nodes.map((entry) => entry.node.id)),
					statsJson: JSON.stringify({ nodeCount: payload.nodes.length, edgeCount: payload.edges.length }),
				},
				actor: actor(body, defaultActor),
			});
		}
		return c.json({ ok: true, payload });
	});

	app.post(withPrefix(prefix, '/graph/context-pack'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const payload = await options.sdk.buildContextPack(body as never);
		if (typeof body.workDayId === 'string' && body.workDayId) {
			await options.sdk.create({
				model: 'graph_run',
				data: {
					workDayId: body.workDayId,
					corpusHash: String(body.corpusHash ?? 'context-pack'),
					graphVersion: String(body.graphVersion ?? ''),
					queryJson: JSON.stringify(body),
					seedIdsJson: JSON.stringify(payload.seedIds),
					selectedNodeIdsJson: JSON.stringify(payload.includedNodeIds),
					statsJson: JSON.stringify({
						nodeCount: payload.nodes.length,
						edgeCount: payload.edges.length,
						totalTokenEstimate: payload.totalTokenEstimate,
					}),
				},
				actor: actor(body, defaultActor),
			});
		}
		return c.json({ ok: true, payload });
	});

	app.post(withPrefix(prefix, '/graph/parse-dsl'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const payload = await options.sdk.parseGraphDsl(String(body.source ?? body.query ?? ''));
		return c.json({ ok: true, payload });
	});

	app.get(withPrefix(prefix, '/graph/node/:id'), async (c) => {
		if (options.scope) {
			const unauthorized = requireScope(c, options.scope);
			if (unauthorized) return unauthorized;
		}
		const payload = await options.sdk.getGraphNode(c.req.param('id'));
		return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Unknown graph node.');
	});
}
