import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { Hono } from 'hono';
import { describe,expect,it } from 'vitest';
import type { CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';
import { installProjectAgentOperatorRoutes } from '../../../../../src/api/capacity/routes/projects/projects-core/project-agent-operator.ts';

describe('project agent operator routes', () => {
	it('forwards filters and one validated keyset page contract to every collection', async () => {
		const app = new Hono();
		const calls: Array<Record<string, unknown>> = [];
		const result = { items: [], page: { limit: 1, hasMore: false, nextCursor: null } };
		const store = {
			async listProjectAgentClassesPage(projectId: string, filters: Record<string, unknown>) { calls.push({ collection: 'classes', projectId, ...filters }); return result; },
			async listAgentModeRunsPage(projectId: string, filters: Record<string, unknown>) { calls.push({ collection: 'mode-runs', projectId, ...filters }); return result; },
			async listAgentFallbackOutputsPage(projectId: string, filters: Record<string, unknown>) { calls.push({ collection: 'fallbacks', projectId, ...filters }); return result; },
			async listTreeDxProxyAuditPage(projectId: string, filters: Record<string, unknown>) { calls.push({ collection: 'audit', projectId, ...filters }); return result; },
		} as unknown as CapacityGovernanceDatabase;
		installProjectAgentOperatorRoutes(app, {
			store,
			async requireProjectAccess() { return {}; },
		});
		const cursor = encodeCapacityPageCursor({ createdAt: '2026-01-01T00:00:00.000Z', id: 'cursor-id' });
		const page = `limit=1&cursor=${encodeURIComponent(cursor)}`;
		for (const path of [
			`/v1/projects/project-a/agent-classes?${page}`,
			`/v1/projects/project-a/agent-mode-runs?mode=planning&assignmentId=assignment-a&${page}`,
			`/v1/projects/project-a/agent-fallback-outputs?mode=planning&status=draft&assignmentId=assignment-a&${page}`,
			`/v1/projects/project-a/treedx-proxy-audit?actorType=provider&assignmentId=assignment-a&${page}`,
		]) {
			const response = await app.request(path);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true, payload: result });
		}
		expect(calls.map((call) => call.collection)).toEqual(['classes', 'mode-runs', 'fallbacks', 'audit']);
		expect(calls.every((call) => call.limit === 1 && (call.cursor as { id?: string } | null)?.id === 'cursor-id')).toBe(true);
	});

	it('rejects invalid limits before touching persistence', async () => {
		const app = new Hono();
		installProjectAgentOperatorRoutes(app, {
			store: {} as CapacityGovernanceDatabase,
			async requireProjectAccess() { return {}; },
		});
		const response = await app.request('/v1/projects/project-a/agent-mode-runs?limit=201');
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ ok: false, code: 'capacity_page_invalid' });
	});

	it('projects activity without repeated execution context and preserves agent messages', async () => {
		const app = new Hono();
		const store = {
			async listAgentModeRunsPage() {
				return {
					items: [{
						id: 'message-a', status: 'running', selectedInput: { repeated: 'large context' },
						outputs: { status: 'message_recorded', metadata: {
							message: { payload: { item: { type: 'agent_message', text: 'Live editorial update' } } },
							workPackage: { instructions: 'write', context: { coreObjective: 'objective', treeDxEvidence: [{ body: 'omit me' }] } },
						} },
					}],
					page: { limit: 200, hasMore: false, nextCursor: null },
				};
			},
		} as unknown as CapacityGovernanceDatabase;
		installProjectAgentOperatorRoutes(app, { store, async requireProjectAccess() { return {}; } });
		const response = await app.request('/v1/projects/project-a/agent-mode-runs?projection=activity');
		expect(response.status).toBe(200);
		const body = await response.json() as { payload: { items: Array<Record<string, unknown>> } };
		expect(body.payload.items[0]).not.toHaveProperty('selectedInput');
		expect(body.payload.items[0]).not.toHaveProperty('outputs.metadata.workPackage.context.treeDxEvidence');
		expect(body.payload.items[0]).toHaveProperty('outputs.metadata.message.payload.item.text', 'Live editorial update');
		expect(body.payload.items[0]).toHaveProperty('outputs.metadata.workPackage.context.coreObjective', 'objective');
	});

	it('pages assignment timeline telemetry without embedding the full mode-run history', async () => {
		const app = new Hono();
		const assignment = { id: 'assignment-a', projectId: 'project-a', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' };
		const store = {
			async getProviderAssignment() { return assignment; },
			async listAgentModeRunsPage() {
				return {
					items: [{ id: 'mode-a', status: 'succeeded', outputs: {}, createdAt: '2026-01-01T00:00:01.000Z' }],
					page: { limit: 1, hasMore: true, nextCursor: 'next' },
				};
			},
		} as unknown as CapacityGovernanceDatabase;
		installProjectAgentOperatorRoutes(app, {
			store,
			async requireProjectAccess() { return { details: { project: { teamId: 'team-a' } } }; },
		});
		const response = await app.request('/v1/projects/project-a/assignments/assignment-a/timeline?limit=1');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			payload: {
				assignment,
				items: [
					{ type: 'assignment_created', id: 'assignment-a:created' },
					{ type: 'completed', id: 'mode-a' },
				],
				page: { limit: 1, hasMore: true, nextCursor: 'next' },
			},
		});
	});
});
