import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { MarketPostgresDatabase } from '../../../../src/api/support/market-postgres.ts';
import { MarketControlPlaneStore } from '../../../../src/api/persistence/store.ts';
import { createCapacityControlPlane } from '../../../../src/api/capacity/control-plane.ts';
import { serializeStructuredAgentEstimateRow } from '../../../../src/api/capacity/repositories/support/structured-estimate.ts';
import { installStructuredEstimateRoutes } from '../../../../src/api/capacity/routes/support/structured-estimates.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market')) ? resolve(packageRoot, '../sdk/drizzle/market') : resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function harness() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	return { database, store: createCapacityControlPlane(new MarketControlPlaneStore({ repoRoot: packageRoot }, database)) };
}

async function seed(store: ReturnType<typeof harness>['store']) {
	const now = new Date().toISOString();
	await store.ensureInitialized();
	await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', ?, ?)`, [now, now]);
}

function input(overrides: Record<string, unknown> = {}) {
	return { id: 'estimate-a', projectId: 'project-a', agentClass: 'engineer', minCredits: 1, expectedCredits: 2, maxCredits: 3, assumptions: [], blockers: [], dependencies: [], expectedOutputs: [], acceptanceCriteria: ['tests pass'], completionEvidence: [], ...overrides };
}

describe('structured agent estimate service', () => {
	it('persists the estimate and planning provenance through one transactional batch', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			const created = await store.createStructuredAgentEstimate('decision-a', input());
			expect(created).toMatchObject({ id: 'estimate-a', teamId: 'team-a', decisionId: 'decision-a', status: 'submitted', expectedCredits: 2 });
			expect(await store.getDecisionPlanningStatus('decision-a')).toMatchObject({ projectId: 'project-a', executionReadiness: 'blocked', planningInputsStatus: 'complete' });
		} finally { await database.close(); }
	});

	it('enforces one-way status transitions and strict status filters', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			await store.createStructuredAgentEstimate('decision-a', input());
			expect(await store.acceptStructuredAgentEstimate('estimate-a', { reason: 'reviewed' })).toMatchObject({ status: 'accepted', acceptedAt: expect.any(String) });
			await expect(store.rejectStructuredAgentEstimate('estimate-a', {})).rejects.toMatchObject({ code: 'structured_agent_estimate_transition_conflict' });
			const invalidFilter = { status: 'invented' } as unknown as Parameters<typeof store.listStructuredAgentEstimatesForDecision>[1];
			await expect(store.listStructuredAgentEstimatesForDecision('decision-a', invalidFilter)).rejects.toMatchObject({ code: 'structured_agent_estimate_status_invalid' });
		} finally { await database.close(); }
	});

	it('fails closed when durable JSON or column state is corrupt', () => {
		const row = {
			id: 'estimate-a', team_id: 'team-a', project_id: 'project-a', decision_id: 'decision-a', proposal_id: null, work_unit_id: null,
			agent_class: 'engineer', agent_id: null, status: 'submitted', estimate_json: JSON.stringify({ ...input(), teamId: 'team-a', decisionId: 'decision-a', confidence: 'medium', riskLevel: 'medium', metadata: {} }),
			metadata_json: '[]', created_at: new Date().toISOString(), accepted_at: null, rejected_at: null,
		};
		expect(() => serializeStructuredAgentEstimateRow(row)).toThrowError(/metadata_json/);
	});

	it('authorizes estimate transitions before mutation', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			await store.createStructuredAgentEstimate('decision-a', input());
			const app = new Hono();
			installStructuredEstimateRoutes(app, {
				store,
				async requireProjectAccess(c) { return c.req.header('x-deny') === 'true' ? { response: c.json({ ok: false }, 403) } : {}; },
			});
			const denied = await app.request('/v1/structured-agent-estimates/estimate-a/accept', { method: 'POST', headers: { 'x-deny': 'true' } });
			expect(denied.status).toBe(403);
			expect(await store.getStructuredAgentEstimate('estimate-a')).toMatchObject({ status: 'submitted' });
			const accepted = await app.request('/v1/structured-agent-estimates/estimate-a/accept', { method: 'POST' });
			expect(accepted.status).toBe(200);
			expect(await accepted.json()).toMatchObject({ payload: { status: 'accepted' } });
		} finally { await database.close(); }
	});
});
