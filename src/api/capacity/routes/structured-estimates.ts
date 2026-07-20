import type { DecisionPlanningStatus, StructuredAgentEstimateRecord, StructuredAgentEstimateStatus } from '@treeseed/sdk/agent-capacity';
import type { Context, Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { readCapacityRequestObject } from './request-json.ts';

interface StructuredEstimateStore extends CapacityGovernanceDatabase {
	getDecisionPlanningStatus(decisionId: string): Promise<DecisionPlanningStatus | null>;
	createStructuredAgentEstimate(decisionId: string, input: Record<string, unknown>): Promise<StructuredAgentEstimateRecord | null>;
	listStructuredAgentEstimatesForDecision(decisionId: string, filters: { status: StructuredAgentEstimateStatus | null }): Promise<StructuredAgentEstimateRecord[]>;
	getStructuredAgentEstimate(id: string): Promise<StructuredAgentEstimateRecord | null>;
	updateStructuredAgentEstimateStatus(id: string, status: 'accepted' | 'rejected', input: Record<string, unknown>): Promise<StructuredAgentEstimateRecord | null>;
}

export interface StructuredEstimateRouteOptions {
	store: CapacityGovernanceDatabase;
	requireProjectAccess(c: Context, store: CapacityGovernanceDatabase, projectId: string, permission: string): Promise<{ response?: Response | null }>;
}

const STATUSES = new Set<StructuredAgentEstimateStatus>(['submitted', 'accepted', 'rejected', 'superseded']);
function error(c: Context, status: 400 | 404, message: string) { return c.json({ ok: false, error: message }, { status }); }
function status(value: unknown): StructuredAgentEstimateStatus | null {
	if (value == null || value === '') return null;
	const candidate = String(value) as StructuredAgentEstimateStatus;
	if (!STATUSES.has(candidate)) throw new CapacityGovernanceError('structured_agent_estimate_status_invalid', `Unknown structured estimate status ${candidate}.`, 400);
	return candidate;
}

export function installStructuredEstimateRoutes(app: Hono, options: StructuredEstimateRouteOptions) {
	const store = options.store as StructuredEstimateStore;
	app.post('/v1/decisions/:decisionId/estimates', async (c) => {
		const body = await readCapacityRequestObject(c, { optional: true });
		const projectId = typeof body.projectId === 'string' ? body.projectId : '';
		if (!projectId) return error(c, 400, 'projectId is required.');
		const access = await options.requireProjectAccess(c, options.store, projectId, 'projects:manage:team');
		if (access.response) return access.response;
		const estimate = await store.createStructuredAgentEstimate(c.req.param('decisionId'), body);
		return estimate ? c.json({ ok: true, payload: estimate }, { status: 201 }) : error(c, 404, 'Unknown project.');
	});

	app.get('/v1/decisions/:decisionId/estimates', async (c) => {
		const decisionId = c.req.param('decisionId');
		const estimates = await store.listStructuredAgentEstimatesForDecision(decisionId, { status: status(c.req.query('status')) });
		const planning = estimates.length ? null : await store.getDecisionPlanningStatus(decisionId);
		const projectId = estimates[0]?.projectId ?? planning?.projectId;
		if (!projectId) return error(c, 404, 'Unknown decision planning status.');
		const access = await options.requireProjectAccess(c, options.store, projectId, 'projects:read:team');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: estimates });
	});

	const transition = (next: 'accepted' | 'rejected') => async (c: Context) => {
			const existing = await store.getStructuredAgentEstimate(c.req.param('estimateId'));
			if (!existing) return error(c, 404, 'Unknown structured agent estimate.');
			const access = await options.requireProjectAccess(c, options.store, existing.projectId, 'projects:manage:team');
			if (access.response) return access.response;
			const body = await readCapacityRequestObject(c, { optional: true });
			const updated = await store.updateStructuredAgentEstimateStatus(c.req.param('estimateId'), next, body);
			return updated ? c.json({ ok: true, payload: updated }) : error(c, 404, 'Unknown structured agent estimate.');
	};
	app.post('/v1/structured-agent-estimates/:estimateId/accept', transition('accepted'));
	app.post('/v1/structured-agent-estimates/:estimateId/reject', transition('rejected'));
}
