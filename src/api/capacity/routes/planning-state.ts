import type {
	DecisionExecutionInputRecord,
	DecisionExecutionInputStatus,
	DecisionPlanningStatus,
	PlanningInputRequest,
} from '@treeseed/sdk/agent-capacity';
import type { Context, Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { readCapacityRequestObject } from './request-json.ts';

const EXECUTION_STATUSES = new Set<DecisionExecutionInputStatus>(['proposed', 'accepted', 'revision_requested', 'rejected', 'stale']);

interface PlanningStateStore extends CapacityGovernanceDatabase {
	getDecisionPlanningStatus(decisionId: string): Promise<DecisionPlanningStatus | null>;
	createPlanningInputRequest(decisionId: string, input: Record<string, unknown>): Promise<PlanningInputRequest | null>;
	listDecisionExecutionInputs(decisionId: string, filters: { status: DecisionExecutionInputStatus | null }): Promise<DecisionExecutionInputRecord[]>;
	createDecisionExecutionInput(decisionId: string, input: Record<string, unknown>): Promise<DecisionExecutionInputRecord | null>;
	getDecisionExecutionInput(inputId: string): Promise<DecisionExecutionInputRecord | null>;
	updateDecisionExecutionInputStatus(inputId: string, status: DecisionExecutionInputStatus, input: Record<string, unknown>): Promise<DecisionExecutionInputRecord | null>;
}

export interface PlanningStateRouteOptions {
	store: CapacityGovernanceDatabase;
	requireProjectAccess(c: Context, store: CapacityGovernanceDatabase, projectId: string, permission: string): Promise<{ response?: Response | null }>;
}

function error(c: Context, status: 400 | 404, message: string) {
	return c.json({ ok: false, error: message }, { status });
}

function executionStatus(value: unknown): DecisionExecutionInputStatus | null {
	if (value == null || value === '') return null;
	const candidate = String(value) as DecisionExecutionInputStatus;
	if (!EXECUTION_STATUSES.has(candidate)) throw new CapacityGovernanceError('decision_execution_input_status_invalid', `Unknown decision execution input status ${candidate}.`, 400);
	return candidate;
}

export function installPlanningStateRoutes(app: Hono, options: PlanningStateRouteOptions) {
	const store = options.store as PlanningStateStore;

	app.get('/v1/decisions/:decisionId/planning-status', async (c) => {
		const status = await store.getDecisionPlanningStatus(c.req.param('decisionId'));
		if (!status) return error(c, 404, 'Unknown decision planning status.');
		const access = await options.requireProjectAccess(c, options.store, status.projectId, 'projects:read:team');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: status });
	});

	app.post('/v1/decisions/:decisionId/planning-input-requests', async (c) => {
		const body = await readCapacityRequestObject(c, { optional: true });
		const projectId = typeof body.projectId === 'string' ? body.projectId : '';
		if (!projectId) return error(c, 400, 'projectId is required.');
		const access = await options.requireProjectAccess(c, options.store, projectId, 'projects:manage:team');
		if (access.response) return access.response;
		const request = await store.createPlanningInputRequest(c.req.param('decisionId'), body);
		return request ? c.json({ ok: true, payload: request }, { status: 201 }) : error(c, 404, 'Unknown project.');
	});

	app.get('/v1/decisions/:decisionId/execution-inputs', async (c) => {
		const status = await store.getDecisionPlanningStatus(c.req.param('decisionId'));
		if (!status) return error(c, 404, 'Unknown decision planning status.');
		const access = await options.requireProjectAccess(c, options.store, status.projectId, 'projects:read:team');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: await store.listDecisionExecutionInputs(c.req.param('decisionId'), { status: executionStatus(c.req.query('status')) }) });
	});

	app.post('/v1/decisions/:decisionId/execution-inputs', async (c) => {
		const body = await readCapacityRequestObject(c, { optional: true });
		const projectId = typeof body.projectId === 'string' ? body.projectId : '';
		if (!projectId) return error(c, 400, 'projectId is required.');
		const access = await options.requireProjectAccess(c, options.store, projectId, 'projects:manage:team');
		if (access.response) return access.response;
		const input = await store.createDecisionExecutionInput(c.req.param('decisionId'), body);
		return input ? c.json({ ok: true, payload: input }, { status: 201 }) : error(c, 404, 'Unknown project.');
	});

	const transition = (status: DecisionExecutionInputStatus) => async (c: Context) => {
		const existing = await store.getDecisionExecutionInput(c.req.param('inputId'));
		if (!existing) return error(c, 404, 'Unknown decision execution input.');
		const access = await options.requireProjectAccess(c, options.store, existing.projectId, 'projects:manage:team');
		if (access.response) return access.response;
		const body = await readCapacityRequestObject(c, { optional: true });
		return c.json({ ok: true, payload: await store.updateDecisionExecutionInputStatus(existing.id, status, body) });
	};

	app.post('/v1/decision-execution-inputs/:inputId/accept', transition('accepted'));
	app.post('/v1/decision-execution-inputs/:inputId/request-revision', transition('revision_requested'));
}
