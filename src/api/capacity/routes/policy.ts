import type { Context, Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { CapacityGrantService } from '../services/grant-service.ts';
import type { CapacityGrantStatus } from '@treeseed/sdk/agent-capacity/allocation';
import { CapacityAllocationPolicyError, CapacityAllocationService } from '../services/allocation-service.ts';
import { decodeCapacityPageCursor, normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import { readCapacityRequestObject } from './request-json.ts';
import { explainCapacityAllocation } from '../services/allocation-explanation-service.ts';
import type { CapacityAdmissionStateRequest } from '../services/admission-state-service.ts';

interface CapacityPolicyRouteOptions {
	store: CapacityGovernanceDatabase;
	requireTeamAccess(c: Context, store: CapacityGovernanceDatabase, teamId: string, permission: string): Promise<{ response?: Response | null }>;
}

function failure(c: Context, error: unknown) {
	if (error instanceof CapacityGovernanceError) return c.json({ ok: false, error: error.message, code: error.code, details: error.details }, { status: error.status });
	if (error instanceof CapacityAllocationPolicyError) return c.json({ ok: false, error: error.message, code: error.code, diagnostics: error.diagnostics }, { status: error.status });
	return c.json({ ok: false, error: error instanceof Error ? error.message : String(error), code: 'capacity_policy_failed' }, { status: 500 });
}

function optionalGrantStatus(value: string | undefined): CapacityGrantStatus | undefined {
	if (value === undefined) return undefined;
	if (value === 'planned' || value === 'active' || value === 'paused' || value === 'revoked' || value === 'expired') return value;
	throw new CapacityGovernanceError('capacity_grant_status_invalid', `Unknown capacity grant status "${value}".`, 400);
}

function idempotencyKey(c: Context) {
	const key = c.req.header('Idempotency-Key')?.trim();
	if (!key) throw new CapacityGovernanceError('capacity_idempotency_key_required', 'An idempotency key is required.', 400);
	return key;
}

export function installCapacityPolicyRoutes(app: Hono, options: CapacityPolicyRouteOptions) {
	const grants = new CapacityGrantService(options.store);
	const allocations = new CapacityAllocationService(options.store);
	const read = (c: Context) => options.requireTeamAccess(c, options.store, c.req.param('teamId'), 'projects:read:team');
	const manage = (c: Context) => options.requireTeamAccess(c, options.store, c.req.param('teamId'), 'teams:manage:team');

	app.get('/v1/teams/:teamId/capacity-grants', async (c) => {
		try {
			const access = await read(c); if (access.response) return access.response;
			return c.json({ ok: true, payload: await grants.listPage(c.req.param('teamId'), {
				projectId: c.req.query('projectId'), membershipId: c.req.query('membershipId'), providerId: c.req.query('providerId'),
				environment: c.req.query('environment'), status: optionalGrantStatus(c.req.query('status')),
				limit: c.req.query('limit'), cursor: c.req.query('cursor'),
			}) });
		} catch (error) { return failure(c, error); }
	});

	app.get('/v1/teams/:teamId/capacity-grants/:grantId', async (c) => {
		try {
			const access = await read(c); if (access.response) return access.response;
			const grant = await grants.get(c.req.param('teamId'), c.req.param('grantId'));
			return grant ? c.json({ ok: true, payload: grant }) : c.json({ ok: false, error: 'Capacity grant does not exist.', code: 'capacity_grant_not_found' }, { status: 404 });
		} catch (error) { return failure(c, error); }
	});

	app.post('/v1/teams/:teamId/capacity-grants', async (c) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			return c.json({ ok: true, payload: await grants.create(c.req.param('teamId'), await readCapacityRequestObject(c), idempotencyKey(c)) }, { status: 201 });
		} catch (error) { return failure(c, error); }
	});

	app.post('/v1/teams/:teamId/capacity-grants/plan', async (c) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			const plan = await grants.plan(c.req.param('teamId'), await readCapacityRequestObject(c));
			return c.json({ ok: plan.validation.ok, payload: plan }, { status: plan.validation.ok ? 200 : 400 });
		} catch (error) { return failure(c, error); }
	});

	const transition = (status: 'active' | 'paused' | 'revoked') => async (c: Context) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			return c.json({ ok: true, payload: await grants.transition(c.req.param('teamId'), c.req.param('grantId'), status, idempotencyKey(c)) });
		} catch (error) { return failure(c, error); }
	};
	app.post('/v1/teams/:teamId/capacity-grants/:grantId/activate', transition('active'));
	app.post('/v1/teams/:teamId/capacity-grants/:grantId/pause', transition('paused'));
	app.post('/v1/teams/:teamId/capacity-grants/:grantId/resume', transition('active'));
	app.post('/v1/teams/:teamId/capacity-grants/:grantId/revoke', transition('revoked'));

	app.get('/v1/teams/:teamId/capacity/allocation-sets', async (c) => {
		try {
			const access = await read(c); if (access.response) return access.response;
			let limit: number;
			let cursor: CapacityPageCursor | null;
			try {
				limit = normalizeCapacityPageLimit(c.req.query('limit'));
				cursor = decodeCapacityPageCursor(c.req.query('cursor'));
			} catch (error) {
				throw new CapacityGovernanceError('capacity_page_invalid', error instanceof Error ? error.message : String(error), 400);
			}
			return c.json({ ok: true, payload: await allocations.listPage(c.req.param('teamId'), { limit, cursor }) });
		} catch (error) { return failure(c, error); }
	});

	app.get('/v1/teams/:teamId/capacity/allocation-sets/:allocationSetId', async (c) => {
		try {
			const access = await read(c); if (access.response) return access.response;
			const allocation = await allocations.get(c.req.param('teamId'), c.req.param('allocationSetId'));
			return allocation ? c.json({ ok: true, payload: allocation }) : c.json({ ok: false, error: 'Capacity allocation set does not exist.', code: 'capacity_allocation_not_found' }, { status: 404 });
		} catch (error) { return failure(c, error); }
	});

	app.post('/v1/teams/:teamId/capacity/allocation-sets/plan', async (c) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			const { candidate, validation } = await allocations.plan(c.req.param('teamId'), await readCapacityRequestObject(c));
			return c.json({ ok: validation.ok, payload: { candidate, validation } }, { status: validation.ok ? 200 : 400 });
		} catch (error) { return failure(c, error); }
	});

	app.post('/v1/teams/:teamId/capacity/allocation-sets', async (c) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			const principal = access as { principal?: { id?: string } };
			const allocation = await allocations.create(c.req.param('teamId'), await readCapacityRequestObject(c), principal.principal?.id ?? null, idempotencyKey(c));
			return c.json({ ok: true, payload: allocation }, { status: 201 });
		} catch (error) { return failure(c, error); }
	});

	app.post('/v1/teams/:teamId/capacity/allocation-sets/:allocationSetId/activate', async (c) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			const allocation = await allocations.activate(c.req.param('teamId'), c.req.param('allocationSetId'), idempotencyKey(c));
			return allocation ? c.json({ ok: true, payload: allocation }) : c.json({ ok: false, error: 'Capacity allocation set does not exist.', code: 'capacity_allocation_not_found' }, { status: 404 });
		} catch (error) { return failure(c, error); }
	});

	app.post('/v1/teams/:teamId/capacity/allocation-sets/:allocationSetId/supersede', async (c) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			const body = await readCapacityRequestObject(c, { optional: true });
			const result = await allocations.supersede(
				c.req.param('teamId'),
				c.req.param('allocationSetId'),
				typeof body.expectedActiveAllocationSetId === 'string' ? body.expectedActiveAllocationSetId : null,
				idempotencyKey(c),
			);
			return c.json({ ok: true, payload: result });
		} catch (error) { return failure(c, error); }
	});

	app.post('/v1/teams/:teamId/capacity/allocation-sets/:allocationSetId/explain', async (c) => {
		try {
			const access = await read(c); if (access.response) return access.response;
			const body = await readCapacityRequestObject(c);
			const request: CapacityAdmissionStateRequest = {
				teamId: c.req.param('teamId'),
				providerId: String(body.providerId ?? ''),
				membershipId: String(body.membershipId ?? ''),
				projectId: String(body.projectId ?? ''),
				environment: String(body.environment ?? ''),
				projectAgentClassId: String(body.projectAgentClassId ?? ''),
				mode: body.mode === 'acting' ? 'acting' : 'planning',
				workDayId: String(body.workDayId ?? ''),
				requestedCredits: Number(body.requestedCredits),
				executionProviderId: typeof body.executionProviderId === 'string' ? body.executionProviderId : null,
				laneId: typeof body.laneId === 'string' ? body.laneId : null,
				providerSessionId: typeof body.providerSessionId === 'string' ? body.providerSessionId : null,
				decisionId: typeof body.decisionId === 'string' ? body.decisionId : null,
				requiredCapabilities: Array.isArray(body.requiredCapabilities) ? body.requiredCapabilities.map(String) : [],
			};
			return c.json({ ok: true, payload: await explainCapacityAllocation(
				options.store,
				c.req.param('allocationSetId'),
				request,
			) });
		} catch (error) { return failure(c, error); }
	});

	app.post('/v1/teams/:teamId/capacity/allocation-sets/:allocationSetId/archive', async (c) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			const allocation = await allocations.archive(c.req.param('teamId'), c.req.param('allocationSetId'), idempotencyKey(c));
			return allocation ? c.json({ ok: true, payload: allocation }) : c.json({ ok: false, error: 'Capacity allocation set does not exist.', code: 'capacity_allocation_not_found' }, { status: 404 });
		} catch (error) { return failure(c, error); }
	});
}
