import { decodeCapacityPageCursor, normalizeCapacityPageLimit, type CapacityPage, type CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import type { Context, Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { installOperatorAgentLabRoutes } from './agent-lab/operator-agent-lab.ts';
import { installOperatorCommunicationRoutes } from './operator-communication.ts';

export interface CapacityOperatorStore extends CapacityGovernanceDatabase {
	listCapacityWorkdayRunsPage(teamId: string, filters: Record<string, unknown> & { limit: number; cursor: CapacityPageCursor | null }): Promise<CapacityPage<Record<string, unknown>>>;
	createCapacityWorkdayRun(teamId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	preflightCapacityWorkdayRunRequest(teamId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
	getCapacityWorkdayRun(teamId: string, runId: string): Promise<Record<string, unknown> | null>;
	updateCapacityWorkdayRun(teamId: string, runId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	tickCapacityWorkdayRun(teamId: string, runId: string, now?: string, idempotencyKey?: string): Promise<Record<string, unknown>>;
	fenceCapacityWorkdayAdmission(teamId: string, runId: string): Promise<Record<string, unknown>>;
	listCapacityWorkdayEventsPage(teamId: string, runId: string, filters: { limit: number; cursor: CapacityPageCursor | null; afterEventIndex?: number | null }): Promise<CapacityPage<Record<string, unknown>>>;
	createCapacityWorkdayEvent(teamId: string, runId: string, input: Record<string, unknown>): Promise<unknown>;
	createCapacityWorkdaySchedule(teamId: string, input: Record<string, unknown>): Promise<unknown>;
	getCapacityWorkdaySchedule(teamId: string, scheduleId: string): Promise<Record<string, unknown> | null>;
	listCapacityWorkdaySchedules(teamId: string): Promise<unknown[]>;
	updateCapacityWorkdaySchedule(teamId: string, scheduleId: string, input: Record<string, unknown>): Promise<unknown>;
	tickCapacityWorkdaySchedule(teamId: string, scheduleId: string, now?: string): Promise<unknown>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<Record<string, unknown> | null>;
}

interface CapacityOperatorRouteOptions {
	store: CapacityGovernanceDatabase;
	requireTeamAccess(c: Context, store: CapacityGovernanceDatabase, teamId: string, permission: string): Promise<{ response?: Response | null; principal?: { id?: string } }>;
	runtimeControlPlaneAuthProvider?: { createServiceToken(input: { serviceId: string; name: string; roles?: string[]; permissions?: string[] }): Promise<{ id: string; serviceId: string; secret: string }> };
	config?: { environment?: string };
}

function query(c: Context, name: string) { const value = c.req.query(name); return typeof value === 'string' && value.trim() ? value.trim() : null; }
function notFound(c: Context, message: string) { return c.json({ ok: false, error: message, code: 'not_found' }, { status: 404 }); }
function operatorError(error: unknown) {
	const candidate = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown; status?: unknown; details?: unknown } : {};
	const status = Number(candidate.status); if (!Number.isInteger(status) || status < 400 || status > 599) throw error;
	return new Response(JSON.stringify({ ok: false, error: typeof candidate.message === 'string' ? candidate.message : 'Capacity operator request failed.',
		code: typeof candidate.code === 'string' ? candidate.code : 'capacity_operator_request_failed',
		details: candidate.details && typeof candidate.details === 'object' ? candidate.details : undefined }),
	{ status, headers: { 'content-type': 'application/json' } });
}
function page(c: Context) { try { return { limit: normalizeCapacityPageLimit(query(c, 'limit')), cursor: decodeCapacityPageCursor(query(c, 'cursor')) }; }
	catch (error) { throw new CapacityGovernanceError('capacity_page_invalid', error instanceof Error ? error.message : String(error), 400); } }

export function installCapacityOperatorRoutes(app: Hono, options: CapacityOperatorRouteOptions) {
	const store = options.store as CapacityOperatorStore;
	const read = (c: Context) => options.requireTeamAccess(c, options.store, c.req.param('teamId'), 'projects:read:team');
	const manage = (c: Context) => options.requireTeamAccess(c, options.store, c.req.param('teamId'), 'teams:manage:team');
	const diagnose = (c: Context) => options.requireTeamAccess(c, options.store, c.req.param('teamId'), 'workday:diagnose');
	const dependencies = { store, read, manage, diagnose, query, page, notFound, operatorError,
		runtimeControlPlaneAuthProvider: options.runtimeControlPlaneAuthProvider, environment: options.config?.environment,
		requireTeamAccess: (c: Context, teamId: string) => options.requireTeamAccess(c, options.store, teamId, 'projects:read:team') };
	installOperatorCommunicationRoutes(app, dependencies);
	installOperatorAgentLabRoutes(app, dependencies);
}
