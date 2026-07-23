import type { Context, Hono } from 'hono';
import {
	decodeCapacityPageCursor,
	normalizeCapacityPageLimit,
	type CapacityPageCursor,
} from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { readCapacityRequestObject } from './request-json.ts';

const EVIDENCE_COLLECTIONS = new Set([
	'assignments',
	'mode-runs',
	'reservations',
	'usage-actuals',
	'ledger-entries',
] as const);

type EvidenceCollection = 'assignments' | 'mode-runs' | 'reservations' | 'usage-actuals' | 'ledger-entries';

interface CapacityWorkdayStore extends CapacityGovernanceDatabase {
	createWorkdayCapacityEnvelope(input: Record<string, unknown>, idempotencyKey?: string | null): Promise<Record<string, unknown> | null>;
	getWorkdayCapacityEnvelope(workdayId: string): Promise<Record<string, unknown> | null>;
	updateWorkdayCapacityEnvelopeState(workdayId: string, status: string, idempotencyKey?: string | null): Promise<Record<string, unknown> | null>;
	getWorkdayCapacitySummary(workdayId: string, options: {
		evidence: EvidenceCollection | null;
		limit: number;
		cursor: CapacityPageCursor | null;
	}): Promise<{ ok: true; payload: { workday?: Record<string, unknown> | null } } | null>;
}

export interface CapacityWorkdayRouteOptions {
	store: CapacityGovernanceDatabase;
	requireProjectAccess(c: Context, store: CapacityGovernanceDatabase, projectId: string, permission: string): Promise<{ response?: Response | null }>;
}

function error(c: Context, status: 400 | 404, message: string) {
	return c.json({ ok: false, error: message }, { status });
}

function governanceError(c: Context, cause: unknown) {
	if (cause instanceof CapacityGovernanceError) {
		return new Response(JSON.stringify({ ok: false, error: cause.message, code: cause.code, details: cause.details }), { status: cause.status, headers: { 'content-type': 'application/json' } });
	}
	throw cause;
}

function projectId(workday: Record<string, unknown>) {
	return String(workday.projectId ?? workday.project_id ?? '');
}

function idempotencyKey(c: Context) {
	const key = c.req.header('Idempotency-Key')?.trim();
	if (!key) throw new CapacityGovernanceError('capacity_idempotency_key_required', 'An idempotency key is required.', 400);
	return key;
}

export function installCapacityWorkdayRoutes(app: Hono, options: CapacityWorkdayRouteOptions) {
	const store = options.store as CapacityWorkdayStore;

	app.post('/v1/workdays', async (c) => {
		try {
			const body = await readCapacityRequestObject(c, { optional: true });
			const requestedProjectId = typeof body.projectId === 'string' ? body.projectId : '';
			if (!requestedProjectId) return error(c, 400, 'projectId is required.');
			const access = await options.requireProjectAccess(c, options.store, requestedProjectId, 'projects:manage:team');
			if (access.response) return access.response;
			const workday = await store.createWorkdayCapacityEnvelope(body, idempotencyKey(c));
			return workday ? c.json({ ok: true, payload: workday }, { status: 201 }) : error(c, 404, 'Unknown project.');
		} catch (cause) {
			return governanceError(c, cause);
		}
	});

	app.get('/v1/workdays/:workdayId', async (c) => {
		const workday = await store.getWorkdayCapacityEnvelope(c.req.param('workdayId'));
		if (!workday) return error(c, 404, 'Unknown workday.');
		const access = await options.requireProjectAccess(c, options.store, projectId(workday), 'projects:read:team');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: workday });
	});

	const transition = (status: 'active' | 'paused' | 'cancelled' | 'completed') => async (c: Context) => {
		try {
			const workday = await store.getWorkdayCapacityEnvelope(c.req.param('workdayId'));
			if (!workday) return error(c, 404, 'Unknown workday.');
			const access = await options.requireProjectAccess(c, options.store, projectId(workday), 'projects:manage:team');
			if (access.response) return access.response;
			return c.json({ ok: true, payload: await store.updateWorkdayCapacityEnvelopeState(String(workday.id), status, idempotencyKey(c)) });
		} catch (cause) {
			return governanceError(c, cause);
		}
		};
	app.post('/v1/workdays/:workdayId/start', transition('active'));
	app.post('/v1/workdays/:workdayId/pause', transition('paused'));
	app.post('/v1/workdays/:workdayId/resume', transition('active'));
	app.post('/v1/workdays/:workdayId/cancel', transition('cancelled'));
	app.post('/v1/workdays/:workdayId/complete', transition('completed'));

	app.get('/v1/workdays/:workdayId/summary', async (c) => {
		const rawEvidence = c.req.query('evidence');
		const evidence = typeof rawEvidence === 'string' && rawEvidence.trim() ? rawEvidence.trim() : null;
		if (evidence && !EVIDENCE_COLLECTIONS.has(evidence as EvidenceCollection)) {
			return error(c, 400, 'Unknown workday summary evidence collection.');
		}
		let limit: number;
		let cursor: CapacityPageCursor | null;
		try {
			limit = normalizeCapacityPageLimit(c.req.query('limit'));
			cursor = decodeCapacityPageCursor(c.req.query('cursor'));
		} catch (cause) {
			return error(c, 400, cause instanceof Error ? cause.message : String(cause));
		}
		if (cursor && !evidence) return error(c, 400, 'Workday summary cursor requires an evidence collection.');
		const summary = await store.getWorkdayCapacitySummary(c.req.param('workdayId'), {
			evidence: evidence as EvidenceCollection | null,
			limit,
			cursor,
		});
		const workday = summary?.payload?.workday;
		if (!workday) return error(c, 404, 'Unknown workday.');
		const access = await options.requireProjectAccess(c, options.store, projectId(workday), 'projects:read:team');
		if (access.response) return access.response;
		return c.json(summary);
	});
}
