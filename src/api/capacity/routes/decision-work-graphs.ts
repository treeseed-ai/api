import type { DecisionAssignmentGraphRecord, DecisionPlanningStatus, DeliverableContractRecord, DeliverableManifestRecord } from '@treeseed/sdk/agent-capacity';
import type { Context, Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { readCapacityRequestObject } from './request-json.ts';

interface DecisionWorkGraphStore extends CapacityGovernanceDatabase {
	getDecisionPlanningStatus(decisionId: string): Promise<DecisionPlanningStatus | null>;
	createDecisionAssignmentGraph(decisionId: string, input: Record<string, unknown>): Promise<DecisionAssignmentGraphRecord | null>;
	activateDecisionAssignmentGraphVersion(id: string): Promise<DecisionAssignmentGraphRecord | null>;
	listDecisionAssignmentGraphsForDecision(decisionId: string, filters: { active?: boolean }): Promise<DecisionAssignmentGraphRecord[]>;
	getDecisionAssignmentGraph(id: string): Promise<DecisionAssignmentGraphRecord | null>;
	getDeliverableContract(id: string): Promise<DeliverableContractRecord | null>;
	getDeliverableManifest(id: string): Promise<DeliverableManifestRecord | null>;
	submitDeliverableManifest(id: string, input: Record<string, unknown>): Promise<DeliverableManifestRecord | null>;
	markDeliverableContractApproved(id: string, input: Record<string, unknown>): Promise<DeliverableContractRecord | null>;
	markDeliverableContractRejected(id: string, input: Record<string, unknown>): Promise<DeliverableContractRecord | null>;
}

export interface DecisionWorkGraphRouteOptions {
	store: CapacityGovernanceDatabase;
	requireProjectAccess(c: Context, store: CapacityGovernanceDatabase, projectId: string, permission: string): Promise<{ response?: Response | null }>;
}
function error(c: Context, status: 400 | 404, message: string) { return c.json({ ok: false, error: message }, { status }); }
function active(value: unknown): boolean | undefined {
	if (value == null || value === '') return undefined;
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new CapacityGovernanceError('decision_assignment_graph_active_filter_invalid', 'active must be true or false.', 400);
}

export function installDecisionWorkGraphRoutes(app: Hono, options: DecisionWorkGraphRouteOptions) {
	const store = options.store as DecisionWorkGraphStore;
	app.post('/v1/decisions/:decisionId/assignment-graphs/compile', async (c) => {
		const body = await readCapacityRequestObject(c, { optional: true });
		const projectId = typeof body.projectId === 'string' ? body.projectId : '';
		if (!projectId) return error(c, 400, 'projectId is required.');
		const access = await options.requireProjectAccess(c, options.store, projectId, 'projects:manage:team');
		if (access.response) return access.response;
		const graph = await store.createDecisionAssignmentGraph(c.req.param('decisionId'), body);
		if (!graph) return error(c, 404, 'Unknown project.');
		const result = body.activate === false ? graph : await store.activateDecisionAssignmentGraphVersion(graph.id);
		return c.json({ ok: true, payload: result ?? graph }, { status: 201 });
	});

	app.get('/v1/decisions/:decisionId/assignment-graphs', async (c) => {
		const decisionId = c.req.param('decisionId');
		const graphs = await store.listDecisionAssignmentGraphsForDecision(decisionId, { active: active(c.req.query('active')) });
		const planning = graphs.length ? null : await store.getDecisionPlanningStatus(decisionId);
		const projectId = graphs[0]?.projectId ?? planning?.projectId;
		if (!projectId) return error(c, 404, 'Unknown decision planning status.');
		const access = await options.requireProjectAccess(c, options.store, projectId, 'projects:read:team');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: graphs });
	});

	app.get('/v1/decision-assignment-graphs/:graphId', async (c) => {
		const graph = await store.getDecisionAssignmentGraph(c.req.param('graphId'));
		if (!graph) return error(c, 404, 'Unknown decision assignment graph.');
		const access = await options.requireProjectAccess(c, options.store, graph.projectId, 'projects:read:team');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: graph });
	});

	app.get('/v1/deliverable-manifests/:manifestId', async (c) => {
		const manifest = await store.getDeliverableManifest(c.req.param('manifestId'));
		if (!manifest) return error(c, 404, 'Unknown deliverable manifest.');
		const access = await options.requireProjectAccess(c, options.store, manifest.projectId, 'projects:read:team');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: manifest });
	});

	app.post('/v1/deliverable-contracts/:contractId/manifests', async (c) => {
		const contract = await store.getDeliverableContract(c.req.param('contractId'));
		if (!contract) return error(c, 404, 'Unknown deliverable contract.');
		const access = await options.requireProjectAccess(c, options.store, contract.projectId, 'projects:manage:team');
		if (access.response) return access.response;
		const manifest = await store.submitDeliverableManifest(contract.id, await readCapacityRequestObject(c, { optional: true }));
		return manifest ? c.json({ ok: true, payload: manifest }, { status: 201 }) : error(c, 404, 'Unknown deliverable contract.');
	});

	const transition = (next: 'approved' | 'rejected') => async (c: Context) => {
			const contract = await store.getDeliverableContract(c.req.param('contractId'));
			if (!contract) return error(c, 404, 'Unknown deliverable contract.');
			const access = await options.requireProjectAccess(c, options.store, contract.projectId, 'projects:manage:team');
			if (access.response) return access.response;
			const body = await readCapacityRequestObject(c, { optional: true });
			const updated = next === 'approved' ? await store.markDeliverableContractApproved(contract.id, body) : await store.markDeliverableContractRejected(contract.id, body);
			return updated ? c.json({ ok: true, payload: updated }) : error(c, 404, 'Unknown deliverable contract.');
	};
	app.post('/v1/deliverable-contracts/:contractId/approve', transition('approved'));
	app.post('/v1/deliverable-contracts/:contractId/reject', transition('rejected'));
}
