import { normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import type { Context, Hono } from 'hono';
import { CapacityGovernanceError } from '../../database.ts';
import type { CapacityOperatorStore } from './operator.ts';
import { readCapacityRequestObject } from './request-json.ts';
import { filterWorkdayActivity, redactTranscriptValue } from './workday-activity.ts';

type Access = { response?: Response | null; principal?: { id?: string } };

export interface WorkdayRouteDependencies {
	store: CapacityOperatorStore;
	read(c: Context): Promise<Access>;
	manage(c: Context): Promise<Access>;
	query(c: Context, name: string): string | null;
	page(c: Context): { limit: number; cursor: ReturnType<typeof import('@treeseed/sdk/capacity-pagination').decodeCapacityPageCursor> };
	notFound(c: Context, message: string): Response;
	operatorError(error: unknown): Response;
	requireTeamAccess(c: Context, teamId: string): Promise<Access>;
}

export function installOperatorWorkdayRoutes(app: Hono, dependencies: WorkdayRouteDependencies) {
	const { store, read, manage, query, page, notFound, operatorError } = dependencies;

	app.get('/v1/teams/:teamId/workday-runs', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		try {
			return c.json({ ok: true, payload: await store.listCapacityWorkdayRunsPage(c.req.param('teamId'), { status: query(c, 'status'), providerId: query(c, 'providerId'), ...page(c) }) });
		} catch (error) { return operatorError(error); }
	});
	app.get('/v1/teams/:teamId/workday-schedules', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		return c.json({ ok: true, payload: await store.listCapacityWorkdaySchedules(c.req.param('teamId')) });
	});
	app.post('/v1/teams/:teamId/workday-schedules', async (c) => {
		const access = await manage(c); if (access.response) return access.response;
		try { return c.json({ ok: true, payload: await store.createCapacityWorkdaySchedule(c.req.param('teamId'), await readCapacityRequestObject(c)) }, { status: 201 }); }
		catch (error) { return operatorError(error); }
	});
	app.get('/v1/teams/:teamId/workday-schedules/:scheduleId', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		const schedule = await store.getCapacityWorkdaySchedule(c.req.param('teamId'), c.req.param('scheduleId'));
		return schedule ? c.json({ ok: true, payload: schedule }) : notFound(c, 'Unknown workday schedule.');
	});
	app.patch('/v1/teams/:teamId/workday-schedules/:scheduleId', async (c) => {
		const access = await manage(c); if (access.response) return access.response;
		try { const result = await store.updateCapacityWorkdaySchedule(c.req.param('teamId'), c.req.param('scheduleId'), await readCapacityRequestObject(c)); return result ? c.json({ ok: true, payload: result }) : notFound(c, 'Unknown workday schedule.'); }
		catch (error) { return operatorError(error); }
	});
	app.post('/v1/teams/:teamId/workday-schedules/:scheduleId/tick', async (c) => {
		const access = await manage(c); if (access.response) return access.response;
		try { const body = await readCapacityRequestObject(c, { optional: true }); return c.json({ ok: true, payload: await store.tickCapacityWorkdaySchedule(c.req.param('teamId'), c.req.param('scheduleId'), typeof body.now === 'string' ? body.now : undefined) }); }
		catch (error) { return operatorError(error); }
	});
	app.post('/v1/teams/:teamId/workday-runs', async (c) => {
		const access = await manage(c); if (access.response) return access.response;
		try {
			const body = await readCapacityRequestObject(c, { optional: true });
			return c.json({ ok: true, payload: await store.createCapacityWorkdayRun(c.req.param('teamId'), { ...body, requestedById: access.principal?.id ?? null }) }, { status: 201 });
		} catch (error) { return operatorError(error); }
	});
	app.get('/v1/teams/:teamId/workday-runs/:runId', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		const run = await store.getCapacityWorkdayRun(c.req.param('teamId'), c.req.param('runId'));
		if (!run) return notFound(c, 'Unknown workday run.');
		const events = await store.listCapacityWorkdayEventsPage(c.req.param('teamId'), String(run.id), { limit: 50, cursor: null });
		return c.json({ ok: true, payload: { run, events: events.items, eventPage: events.page } });
	});
	app.patch('/v1/teams/:teamId/workday-runs/:runId', async (c) => {
		const access = await manage(c); if (access.response) return access.response;
		try {
			const run = await store.updateCapacityWorkdayRun(c.req.param('teamId'), c.req.param('runId'), await readCapacityRequestObject(c, { optional: true }));
			return run ? c.json({ ok: true, payload: run }) : notFound(c, 'Unknown workday run.');
		} catch (error) { return operatorError(error); }
	});
	app.post('/v1/teams/:teamId/workday-runs/:runId/tick', async (c) => {
		const access = await manage(c); if (access.response) return access.response;
		try {
			const body = await readCapacityRequestObject(c, { optional: true });
			const now = typeof body.now === 'string' && body.now ? body.now : undefined;
			const key = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim() ? body.idempotencyKey.trim() : c.req.header('Idempotency-Key')?.trim();
			if (!key) throw new CapacityGovernanceError('capacity_idempotency_key_required', 'An idempotency key is required.', 400);
			return c.json({ ok: true, payload: await store.tickCapacityWorkdayRun(c.req.param('teamId'), c.req.param('runId'), now, key) });
		} catch (error) { return operatorError(error); }
	});
	app.get('/v1/teams/:teamId/workday-runs/:runId/events', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		const run = await store.getCapacityWorkdayRun(c.req.param('teamId'), c.req.param('runId'));
		if (!run) return notFound(c, 'Unknown workday run.');
		try { return c.json({ ok: true, payload: await store.listCapacityWorkdayEventsPage(c.req.param('teamId'), String(run.id), page(c)) }); }
		catch (error) { return operatorError(error); }
	});
	app.post('/v1/teams/:teamId/workday-runs/:runId/events', async (c) => {
		const access = await manage(c); if (access.response) return access.response;
		try {
			const event = await store.createCapacityWorkdayEvent(c.req.param('teamId'), c.req.param('runId'), await readCapacityRequestObject(c, { optional: true }));
			return event ? c.json({ ok: true, payload: event }, { status: 201 }) : notFound(c, 'Unknown workday run.');
		} catch (error) { return operatorError(error); }
	});
}

export function installOperatorActivityRoutes(app: Hono, dependencies: WorkdayRouteDependencies) {
	const { store, read, query, notFound } = dependencies;
	app.get('/v1/teams/:teamId/workday-runs/:runId/activity', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		const run = await store.getCapacityWorkdayRun(c.req.param('teamId'), c.req.param('runId'));
		if (!run) return notFound(c, 'Unknown workday run.');
		const limit = normalizeCapacityPageLimit(query(c, 'limit'));
		const after = Math.max(-1, Number(query(c, 'after') ?? -1));
		const events = await store.listCapacityWorkdayEventsPage(c.req.param('teamId'), String(run.id), { limit: 200, cursor: null, afterEventIndex: after });
		const items = filterWorkdayActivity(events.items as never[], { after, agent: query(c, 'agent'), agentClass: query(c, 'agentClass'), type: query(c, 'type'), severity: query(c, 'severity') }).slice(0, limit);
		return c.json({ ok: true, payload: { items, cursor: items.at(-1)?.sequence ?? Number(query(c, 'after') ?? -1) } });
	});
	app.get('/v1/teams/:teamId/workday-runs/:runId/activity/stream', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		const run = await store.getCapacityWorkdayRun(c.req.param('teamId'), c.req.param('runId'));
		if (!run) return notFound(c, 'Unknown workday run.');
		let after = Number(c.req.header('Last-Event-ID') ?? query(c, 'after') ?? -1);
		const encoder = new TextEncoder();
		const stream = new ReadableStream({ async start(controller) {
			for (let attempt = 0; attempt < 25; attempt += 1) {
				const eventPage = await store.listCapacityWorkdayEventsPage(c.req.param('teamId'), String(run.id), { limit: 200, cursor: null, afterEventIndex: after });
				const items = filterWorkdayActivity(eventPage.items as never[], { after, agent: query(c, 'agent'), agentClass: query(c, 'agentClass'), type: query(c, 'type'), severity: query(c, 'severity') });
				for (const event of items) { after = event.sequence; controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`)); }
				if (attempt < 24) await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
			controller.close();
		} });
		return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
	});
	app.get('/v1/execution-runs/:runId/transcript', async (c) => {
		const run = await store.first(`SELECT team_id, provider_assignment_id FROM agent_mode_runs WHERE id = ? LIMIT 1`, [c.req.param('runId')]);
		if (!run) return notFound(c, 'Unknown execution run.');
		const access = await dependencies.requireTeamAccess(c, String(run.team_id));
		if (access.response) return access.response;
		const limit = normalizeCapacityPageLimit(query(c, 'limit'));
		const after = query(c, 'after');
		const rows = await store.all(`SELECT * FROM agent_mode_runs WHERE team_id = ? AND provider_assignment_id = ?${after ? ' AND created_at > ?' : ''} ORDER BY created_at ASC, id ASC LIMIT ?`,
			after ? [run.team_id, run.provider_assignment_id, after, limit + 1] : [run.team_id, run.provider_assignment_id, limit + 1]);
		const selected = rows.slice(0, limit);
		return c.json({ ok: true, payload: { executionRunId: c.req.param('runId'), redactionStatus: 'sanitized', entries: redactTranscriptValue(selected), page: { limit, hasMore: rows.length > limit, nextAfter: rows.length > limit ? selected.at(-1)?.created_at ?? null : null } } });
	});
}
