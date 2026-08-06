import {
decodeCapacityPageCursor,
normalizeCapacityPageLimit,
type CapacityPage,
type CapacityPageCursor,
} from '@treeseed/sdk/capacity-pagination';
import type { Context,Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { optionalAvailabilityStatus } from '../../services/accounts/availability-session-service.ts';
import { CapacityOverrunService } from '../../services/capacity/accounting/overrun-service.ts';
import { CapacityOperatorEvidenceService } from '../../services/support/operator-evidence-service.ts';
import { readCapacityRequestObject } from './request-json.ts';
import { installOperatorActivityRoutes, installOperatorWorkdayRoutes } from './operator-workdays.ts';
import { installOperatorAgentLabRoutes } from './agent-lab/operator-agent-lab.ts';

export interface CapacityOperatorStore extends CapacityGovernanceDatabase {
	listCapacityWorkdayRunsPage(teamId: string, filters: Record<string, unknown> & { limit: number; cursor: CapacityPageCursor | null }): Promise<CapacityPage<Record<string, unknown>>>;
	createCapacityWorkdayRun(teamId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	getCapacityWorkdayRun(teamId: string, runId: string): Promise<Record<string, unknown> | null>;
	updateCapacityWorkdayRun(teamId: string, runId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	tickCapacityWorkdayRun(teamId: string, runId: string, now?: string, idempotencyKey?: string): Promise<Record<string, unknown>>;
	listCapacityWorkdayEventsPage(teamId: string, runId: string, filters: { limit: number; cursor: CapacityPageCursor | null; afterEventIndex?: number | null }): Promise<CapacityPage<Record<string, unknown>>>;
	createCapacityWorkdayEvent(teamId: string, runId: string, input: Record<string, unknown>): Promise<unknown>;
	createCapacityWorkdaySchedule(teamId: string, input: Record<string, unknown>): Promise<unknown>;
	getCapacityWorkdaySchedule(teamId: string, scheduleId: string): Promise<Record<string, unknown> | null>;
	listCapacityWorkdaySchedules(teamId: string): Promise<unknown[]>;
	updateCapacityWorkdaySchedule(teamId: string, scheduleId: string, input: Record<string, unknown>): Promise<unknown>;
	tickCapacityWorkdaySchedule(teamId: string, scheduleId: string, now?: string): Promise<unknown>;
	listProviderAvailabilitySessionsPage(teamId: string, filters: Record<string, unknown> & { limit: number; cursor: CapacityPageCursor | null }): Promise<CapacityPage<Record<string, unknown>>>;
	listProviderAssignmentsPage(teamId: string, filters: Record<string, unknown> & {
		limit: number;
		cursor: CapacityPageCursor | null;
	}): Promise<CapacityPage<Record<string, unknown>>>;
	listExecutionRunsForTeamPage(teamId: string, filters: Record<string, unknown> & { limit: number; cursor: CapacityPageCursor | null }): Promise<CapacityPage<Record<string, unknown>>>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<Record<string, unknown> | null>;
	cancelCapacityAssignment(teamId: string, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
	requeueCapacityAssignment(teamId: string, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface CapacityOperatorRouteOptions {
	store: CapacityGovernanceDatabase;
	requireTeamAccess(c: Context, store: CapacityGovernanceDatabase, teamId: string, permission: string): Promise<{ response?: Response | null; principal?: { id?: string } }>;
	runtimeMarketAuthProvider?: { createServiceToken(input: { serviceId: string; name: string; roles?: string[]; permissions?: string[] }): Promise<{ id: string; serviceId: string; secret: string }> };
	config?: { environment?: string };
}

function query(c: Context, name: string) {
	const value = c.req.query(name);
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function executionActivityProjection(value: Record<string, unknown>) {
	const input = value.input && typeof value.input === 'object' && !Array.isArray(value.input) ? value.input as Record<string, unknown> : {};
	const selected = input.selectedInput && typeof input.selectedInput === 'object' && !Array.isArray(input.selectedInput)
		? input.selectedInput as Record<string, unknown>
		: {};
	return {
		...Object.fromEntries(Object.entries(value).filter(([key]) => !['input', 'output', 'context', 'metadata', 'modeRuns'].includes(key))),
		input: { selectedInput: { cycle: selected.cycle ?? null } },
	};
}

function notFound(c: Context, message: string) {
	return c.json({ ok: false, error: message, code: 'not_found' }, { status: 404 });
}

function operatorError(error: unknown) {
	const candidate = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown; status?: unknown; details?: unknown } : {};
	const status = Number(candidate.status);
	if (!Number.isInteger(status) || status < 400 || status > 599) throw error;
	return new Response(JSON.stringify({
		ok: false,
		error: typeof candidate.message === 'string' ? candidate.message : 'Capacity operator request failed.',
		code: typeof candidate.code === 'string' ? candidate.code : 'capacity_operator_request_failed',
		details: candidate.details && typeof candidate.details === 'object' ? candidate.details : undefined,
	}), { status, headers: { 'content-type': 'application/json' } });
}

function page(c: Context) {
	try {
		return {
			limit: normalizeCapacityPageLimit(query(c, 'limit')),
			cursor: decodeCapacityPageCursor(query(c, 'cursor')),
		};
	} catch (error) {
		throw new CapacityGovernanceError('capacity_page_invalid', error instanceof Error ? error.message : String(error), 400);
	}
}

function mutationInput(c: Context, body: Record<string, unknown>, actorId?: string) {
	const headerKey = c.req.header('Idempotency-Key');
	return {
		...body,
		idempotencyKey: typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
			? body.idempotencyKey.trim()
			: headerKey?.trim() ?? '',
		actorId: actorId ?? null,
	};
}

export function installCapacityOperatorRoutes(app: Hono, options: CapacityOperatorRouteOptions) {
	const store = options.store as CapacityOperatorStore;
	const overruns = new CapacityOverrunService(options.store);
	const evidence = new CapacityOperatorEvidenceService(options.store);
	const read = (c: Context) => options.requireTeamAccess(c, options.store, c.req.param('teamId'), 'projects:read:team');
	const manage = (c: Context) => options.requireTeamAccess(c, options.store, c.req.param('teamId'), 'teams:manage:team');
	const workdayDependencies = {
		store, read, manage, query, page, notFound, operatorError,
		runtimeMarketAuthProvider: options.runtimeMarketAuthProvider,
		environment: options.config?.environment,
		requireTeamAccess: (c: Context, teamId: string) => options.requireTeamAccess(c, options.store, teamId, 'projects:read:team'),
	};
	installOperatorWorkdayRoutes(app, workdayDependencies);
	installOperatorActivityRoutes(app, workdayDependencies);
	installOperatorAgentLabRoutes(app, workdayDependencies);

	app.get('/v1/teams/:teamId/capacity/availability-sessions', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		try {
			return c.json({ ok: true, payload: await store.listProviderAvailabilitySessionsPage(c.req.param('teamId'), { providerId: query(c, 'providerId'), status: optionalAvailabilityStatus(query(c, 'status')), ...page(c) }) });
		} catch (error) {
			return operatorError(error);
		}
	});

	app.get('/v1/teams/:teamId/capacity/assignments', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		try {
			const limit = normalizeCapacityPageLimit(query(c, 'limit'));
			const cursor = decodeCapacityPageCursor(query(c, 'cursor'));
			return c.json({
				ok: true,
				payload: await store.listProviderAssignmentsPage(c.req.param('teamId'), {
					projectId: query(c, 'projectId'),
					providerId: query(c, 'providerId'),
					status: query(c, 'status'),
					assignmentId: query(c, 'assignmentId'),
					workdayId: query(c, 'workdayId'),
					executionProviderId: query(c, 'executionProviderId'),
					limit,
					cursor,
				}),
			});
		} catch (error) {
			return operatorError(error instanceof CapacityGovernanceError
				? error
				: new CapacityGovernanceError('capacity_page_invalid', error instanceof Error ? error.message : String(error), 400));
		}
	});

	app.get('/v1/teams/:teamId/capacity/assignments/:assignmentId', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		const assignment = await store.getProviderAssignment(c.req.param('teamId'), c.req.param('assignmentId'));
		return assignment ? c.json({ ok: true, payload: assignment }) : notFound(c, 'Unknown assignment.');
	});

	app.get('/v1/teams/:teamId/capacity/execution-runs', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		try {
			const result = await store.listExecutionRunsForTeamPage(c.req.param('teamId'), {
				projectId: query(c, 'projectId'), providerId: query(c, 'providerId'), status: query(c, 'status'), mode: query(c, 'mode'),
				assignmentId: query(c, 'assignmentId'), workdayId: query(c, 'workdayId'), executionProviderId: query(c, 'executionProviderId'),
				projection: query(c, 'projection') === 'activity' ? 'activity' : null,
				...page(c),
			});
			return c.json({ ok: true, payload: query(c, 'projection') === 'activity'
				? { ...result, items: result.items.map(executionActivityProjection) }
				: result });
		} catch (error) {
			return operatorError(error);
		}
	});

	app.get('/v1/teams/:teamId/capacity/assignments/:assignmentId/explanation', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		const assignment = await store.getProviderAssignment(c.req.param('teamId'), c.req.param('assignmentId'));
		if (!assignment) return notFound(c, 'Unknown assignment.');
		return c.json({ ok: true, payload: assignment.explanation ?? {} });
	});

	const evidencePage = (c: Context) => ({
		projectId: query(c, 'projectId') ?? '',
		workDayId: query(c, 'workDayId'),
		...page(c),
	});
	app.get('/v1/teams/:teamId/capacity/reservations', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		try {
			return c.json({ ok: true, payload: await evidence.listReservations(c.req.param('teamId'), evidencePage(c)) });
		} catch (error) { return operatorError(error); }
	});
	app.get('/v1/teams/:teamId/capacity/reservations/:reservationId/explanation', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		try {
			return c.json({ ok: true, payload: await evidence.explainReservation(c.req.param('teamId'), c.req.param('reservationId')) });
		} catch (error) { return operatorError(error); }
	});
	app.get('/v1/teams/:teamId/capacity/usage', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		try {
			return c.json({ ok: true, payload: await evidence.listUsage(c.req.param('teamId'), evidencePage(c)) });
		} catch (error) { return operatorError(error); }
	});
	app.get('/v1/teams/:teamId/capacity/ledger', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		try {
			return c.json({ ok: true, payload: await evidence.listLedger(c.req.param('teamId'), evidencePage(c)) });
		} catch (error) { return operatorError(error); }
	});

	app.post('/v1/teams/:teamId/capacity/assignments/:assignmentId/cancel', async (c) => {
		const access = await manage(c); if (access.response) return access.response;
		try {
			const body = await readCapacityRequestObject(c, { optional: true });
			return c.json({ ok: true, payload: await store.cancelCapacityAssignment(
				c.req.param('teamId'), c.req.param('assignmentId'), mutationInput(c, body, access.principal?.id),
			) });
		} catch (error) {
			return operatorError(error);
		}
	});

	app.post('/v1/teams/:teamId/capacity/assignments/:assignmentId/requeue', async (c) => {
		const access = await manage(c); if (access.response) return access.response;
		try {
			const body = await readCapacityRequestObject(c, { optional: true });
			return c.json({ ok: true, payload: await store.requeueCapacityAssignment(
				c.req.param('teamId'), c.req.param('assignmentId'), mutationInput(c, body, access.principal?.id),
			) });
		} catch (error) {
			return operatorError(error);
		}
	});

	const decideOverrun = (decision: 'approved' | 'rejected') => async (c: Context) => {
		const access = await manage(c); if (access.response) return access.response;
		try {
			const body = await readCapacityRequestObject(c, { optional: true });
			const input = mutationInput(c, body, access.principal?.id);
			return c.json({ ok: true, payload: await overruns.decide(
				c.req.param('teamId'), c.req.param('reservationId'), decision, String(input.actorId ?? 'team-operator'), String(input.idempotencyKey),
			) });
		} catch (error) { return operatorError(error); }
	};
	app.post('/v1/teams/:teamId/capacity/reservations/:reservationId/overrun/approve', decideOverrun('approved'));
	app.post('/v1/teams/:teamId/capacity/reservations/:reservationId/overrun/reject', decideOverrun('rejected'));
}
