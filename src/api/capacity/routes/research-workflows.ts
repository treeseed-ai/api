import type { Context, Hono } from 'hono';
import type { ResearchWorkflowRecord } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { readCapacityRequestObject } from './request-json.ts';

interface ResearchWorkflowStore extends CapacityGovernanceDatabase {
	createResearchWorkflow(projectId: string, input: Record<string, unknown>): Promise<ResearchWorkflowRecord | null>;
	getResearchWorkflow(id: string): Promise<ResearchWorkflowRecord | null>;
	listResearchWorkflows(projectId: string, filters: { status?: string }): Promise<ResearchWorkflowRecord[]>;
	completeResearchWorkflowStage(id: string, stage: string, input: Record<string, unknown>): Promise<ResearchWorkflowRecord | null>;
}
export interface ResearchWorkflowRouteOptions {
	store: CapacityGovernanceDatabase;
	requireProjectAccess(c: Context, store: CapacityGovernanceDatabase, projectId: string, permission: string): Promise<{ response?: Response | null }>;
}
function missing(c: Context) { return c.json({ ok: false, error: 'Unknown research workflow.' }, { status: 404 }); }

export function installResearchWorkflowRoutes(app: Hono, options: ResearchWorkflowRouteOptions) {
	const store = options.store as ResearchWorkflowStore;
	app.post('/v1/projects/:projectId/research-workflows', async (c) => {
		const projectId = c.req.param('projectId');
		const access = await options.requireProjectAccess(c, options.store, projectId, 'projects:manage:team');
		if (access.response) return access.response;
		const workflow = await store.createResearchWorkflow(projectId, await readCapacityRequestObject(c));
		return workflow ? c.json({ ok: true, payload: workflow }, { status: 201 }) : missing(c);
	});
	app.get('/v1/projects/:projectId/research-workflows', async (c) => {
		const projectId = c.req.param('projectId');
		const access = await options.requireProjectAccess(c, options.store, projectId, 'projects:read:team');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: await store.listResearchWorkflows(projectId, { status: c.req.query('status') }) });
	});
	app.get('/v1/research-workflows/:workflowId', async (c) => {
		const workflow = await store.getResearchWorkflow(c.req.param('workflowId'));
		if (!workflow) return missing(c);
		const access = await options.requireProjectAccess(c, options.store, workflow.projectId, 'projects:read:team');
		return access.response ?? c.json({ ok: true, payload: workflow });
	});
	app.post('/v1/research-workflows/:workflowId/stages/:stage/complete', async (c) => {
		const workflow = await store.getResearchWorkflow(c.req.param('workflowId'));
		if (!workflow) return missing(c);
		const access = await options.requireProjectAccess(c, options.store, workflow.projectId, 'projects:manage:team');
		if (access.response) return access.response;
		const updated = await store.completeResearchWorkflowStage(workflow.id, c.req.param('stage'), await readCapacityRequestObject(c));
		return updated ? c.json({ ok: true, payload: updated }) : missing(c);
	});
}
