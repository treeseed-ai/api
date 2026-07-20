import type { Context, Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { readCapacityRequestObject } from './request-json.ts';
import { requireProviderPrincipal, type CapacityProviderAccessPrincipal } from './provider-auth.ts';

interface ProviderAssignmentStore extends CapacityGovernanceDatabase {
	leaseNextProviderAssignment(principal: CapacityProviderAccessPrincipal, input: Record<string, unknown>): Promise<Record<string, unknown>>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<Record<string, unknown> | null>;
	renewProviderAssignmentLease(principal: CapacityProviderAccessPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	returnProviderAssignment(principal: CapacityProviderAccessPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	completeProviderAssignment(principal: CapacityProviderAccessPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	failProviderAssignment(principal: CapacityProviderAccessPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	createAgentModeRun(input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}

function errorResponse(c: Context, error: unknown) {
	if (error instanceof CapacityGovernanceError) {
		return c.json({ ok: false, error: error.message, code: error.code, details: error.details }, { status: error.status });
	}
	throw error;
}

function assertProviderOwnsAssignment(assignment: Record<string, unknown> | null, principal: CapacityProviderAccessPrincipal, action: string) {
	if (!assignment) throw new CapacityGovernanceError('provider_assignment_not_found', 'Unknown assignment.', 404);
	if (assignment.capacityProviderId !== principal.capacityProviderId) {
		throw new CapacityGovernanceError('provider_assignment_forbidden', `Provider cannot ${action} this assignment.`, 403);
	}
	return assignment;
}

export function installProviderAssignmentRoutes(app: Hono, options: { store: CapacityGovernanceDatabase }) {
	const store = options.store as ProviderAssignmentStore;

	app.post('/v1/provider/assignments/next', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:assignments:read']);
			const body = await readCapacityRequestObject(c, { optional: true });
			const result = await store.leaseNextProviderAssignment(principal, body);
			return c.json({ ok: true, payload: result.assignment, assignment: result.assignment, leaseToken: result.leaseToken, leaseSeconds: result.leaseSeconds, diagnostics: result.diagnostics ?? null, leaseDiagnostics: result.diagnostics ?? null });
		} catch (error) { return errorResponse(c, error); }
	});

	app.get('/v1/provider/assignments/:assignmentId', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:assignments:read']);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId, c.req.param('assignmentId')), principal, 'access');
			return c.json({ ok: true, payload: assignment });
		} catch (error) { return errorResponse(c, error); }
	});

	app.get('/v1/provider/assignments/:assignmentId/explanation', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:assignments:read']);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId, c.req.param('assignmentId')), principal, 'access');
			return c.json({ ok: true, payload: assignment.explanation ?? {} });
		} catch (error) { return errorResponse(c, error); }
	});

	const lifecycle = (scope: string, method: 'renewProviderAssignmentLease' | 'returnProviderAssignment' | 'completeProviderAssignment') => async (c: Context) => {
		try {
			const principal = requireProviderPrincipal(c, [scope]);
			const body = await readCapacityRequestObject(c, { optional: true });
			const result = await store[method](principal, c.req.param('assignmentId'), body);
			if (!result) throw new CapacityGovernanceError('provider_assignment_conflict', 'Assignment lease transition was rejected.', 409);
			return c.json({ ok: true, payload: result.assignment, assignment: result.assignment, ...(method === 'renewProviderAssignmentLease' ? { leaseToken: result.leaseToken, leaseSeconds: result.leaseSeconds } : {}) });
		} catch (error) { return errorResponse(c, error); }
	};
	app.post('/v1/provider/assignments/:assignmentId/renew', lifecycle('provider:assignments:read', 'renewProviderAssignmentLease'));
	app.post('/v1/provider/assignments/:assignmentId/return', lifecycle('provider:assignments:write', 'returnProviderAssignment'));
	app.post('/v1/provider/assignments/:assignmentId/complete', lifecycle('provider:assignments:write', 'completeProviderAssignment'));

	app.post('/v1/provider/assignments/:assignmentId/fail', async (c) => {
		try {
			const body = await readCapacityRequestObject(c, { optional: true });
			const scopes = ['provider:assignments:write'];
			if (body.usageActualId || body.modeRunId || body.usageActual || body.usage) scopes.push('provider:usage:write');
			const principal = requireProviderPrincipal(c, scopes);
			const result = await store.failProviderAssignment(principal, c.req.param('assignmentId'), body);
			if (!result) throw new CapacityGovernanceError('provider_assignment_conflict', 'Assignment lease transition was rejected.', 409);
			return c.json({ ok: true, payload: result.assignment, assignment: result.assignment });
		} catch (error) { return errorResponse(c, error); }
	});

	app.post('/v1/provider/assignments/:assignmentId/mode-runs', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:assignments:write', 'provider:usage:write']);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId, c.req.param('assignmentId')), principal, 'update');
			const body = await readCapacityRequestObject(c, { optional: true });
			const modeRun = await store.createAgentModeRun({ ...body, teamId: principal.teamId, providerAssignmentId: assignment.id });
			if (!modeRun) throw new CapacityGovernanceError('provider_assignment_not_found', 'Unknown assignment.', 404);
			return c.json({ ok: true, payload: modeRun }, { status: 201 });
		} catch (error) { return errorResponse(c, error); }
	});
}
