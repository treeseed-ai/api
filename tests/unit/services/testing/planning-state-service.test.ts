import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { MarketPostgresDatabase } from '../../../../src/api/support/market-postgres.ts';
import { MarketControlPlaneStore } from '../../../../src/api/persistence/store.ts';
import { createCapacityControlPlane } from '../../../../src/api/capacity/control-plane.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function createStore() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const db = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	const store = createCapacityControlPlane(new MarketControlPlaneStore({ repoRoot: packageRoot, authSecret: 'test', assertionSecret: 'test', serviceId: 'web', serviceSecret: 'test' }, db));
	return { db, store };
}

describe('typed planning state service', () => {
	it('atomically persists planning provenance and supersedes stale execution scope', async () => {
		const { db, store } = createStore();
		try {
			await store.ensureInitialized();
			const now = new Date().toISOString();
			await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', ?, ?)`, [now, now]);
			await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', ?, ?)`, [now, now]);

			await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, allowed_modes_json, required_capabilities_json, kernel_profile_json, kernel_policy_json, handler_refs_json, output_contracts_json, metadata_json, created_at, updated_at) VALUES ('class-a', 'team-a', 'project-a', 'engineer', 'Engineer', '["acting"]', '[]', '{}', '{}', '{}', '{}', '{}', ?, ?)`, [now, now]);
			const first = await store.createDecisionExecutionInput('decision-a', {
				id: 'input-a', projectId: 'project-a', projectAgentClassId: 'class-a', status: 'accepted', scopeHash: 'scope-a', payload: { objective: 'first' },
				input: {
					workGraphNodeId: 'graph-a:node:test', taskId: 'task-a', workDayId: 'workday-a',
					agentId: 'tester', handlerId: 'actor',
				},
			});
			expect(first).toMatchObject({
				id: 'input-a', status: 'accepted', scopeHash: 'scope-a',
				input: {
					workGraphNodeId: 'graph-a:node:test', taskId: 'task-a', workDayId: 'workday-a',
					agentId: 'tester', handlerId: 'actor', input: { objective: 'first' },
				},
			});
			expect(await store.getDecisionPlanningStatus('decision-a')).toMatchObject({ executionReadiness: 'ready', planningInputsStatus: 'complete', scopeHash: 'scope-a' });

			await store.run(`INSERT INTO agent_capacity_plans (id, team_id, project_id, decision_id, status, scope_hash, expected_credits, high_credits, created_at, updated_at) VALUES ('plan-a', 'team-a', 'project-a', 'decision-a', 'accepted', 'scope-a', 1, 2, ?, ?)`, [now, now]);
			const second = await store.createDecisionExecutionInput('decision-a', {
				id: 'input-b', projectId: 'project-a', projectAgentClassId: 'class-a', status: 'proposed', scopeHash: 'scope-b',
				input: { workGraphNodeId: 'graph-a:node:test' }, payload: { objective: 'second' },
			});
			expect(second).toMatchObject({ id: 'input-b', status: 'proposed', scopeHash: 'scope-b' });
			expect(await store.getDecisionExecutionInput('input-a')).toMatchObject({ status: 'stale' });
			expect(await store.getAgentCapacityPlan('plan-a')).toMatchObject({ status: 'superseded' });
			expect(await store.getDecisionPlanningStatus('decision-a')).toMatchObject({ executionReadiness: 'blocked', scopeHash: 'scope-b' });
		} finally {
			db.close();
		}
	});

	it('fails closed when accepted acting input has no work-graph node provenance', async () => {
		const { db, store } = createStore();
		try {
			await store.ensureInitialized();
			const now = new Date().toISOString();
			await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', ?, ?)`, [now, now]);
			await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', ?, ?)`, [now, now]);
			await expect(store.createDecisionExecutionInput('decision-a', {
				id: 'input-a', projectId: 'project-a', projectAgentClassId: 'class-a', mode: 'acting', status: 'accepted', payload: {},
			})).rejects.toMatchObject({ code: 'decision_execution_input_work_graph_node_required', status: 409 });
		} finally {
			db.close();
		}
	});

	it('preserves sibling graph-node inputs and supersedes plans only when the same node changes scope', async () => {
		const { db, store } = createStore();
		try {
			await store.ensureInitialized();
			const now = new Date().toISOString();
			await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', ?, ?)`, [now, now]);
			await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', ?, ?)`, [now, now]);
			await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, allowed_modes_json, required_capabilities_json, kernel_profile_json, kernel_policy_json, handler_refs_json, output_contracts_json, metadata_json, created_at, updated_at) VALUES ('class-a', 'team-a', 'project-a', 'engineer', 'Engineer', '["acting"]', '[]', '{}', '{}', '{}', '{}', '{}', ?, ?)`, [now, now]);
			const create = (id: string, nodeId: string, scopeHash: string) => store.createDecisionExecutionInput('decision-a', {
				id, projectId: 'project-a', projectAgentClassId: 'class-a', status: 'accepted', scopeHash,
				input: { workGraphNodeId: nodeId, handlerId: 'actor' }, payload: { objective: 'ship' },
			});
			await create('input-test', 'graph-a:node:test', 'scope-test-v1');
			await create('input-implementation', 'graph-a:node:implementation', 'scope-implementation-v1');
			expect(await store.listDecisionExecutionInputs('decision-a', { status: 'accepted' })).toHaveLength(2);
			await store.run(`INSERT INTO agent_capacity_plans (id, team_id, project_id, decision_id, status, scope_hash, expected_credits, high_credits, created_at, updated_at) VALUES ('plan-a', 'team-a', 'project-a', 'decision-a', 'accepted', 'aggregate-scope', 2, 2, ?, ?)`, [now, now]);

			await create('input-test', 'graph-a:node:test', 'scope-test-v1');
			expect(await store.getAgentCapacityPlan('plan-a')).toMatchObject({ status: 'accepted' });

			await create('input-test-v2', 'graph-a:node:test', 'scope-test-v2');
			expect(await store.getDecisionExecutionInput('input-test')).toMatchObject({ status: 'stale', workGraphNodeId: 'graph-a:node:test' });
			expect(await store.getDecisionExecutionInput('input-test-v2')).toMatchObject({ status: 'accepted', workGraphNodeId: 'graph-a:node:test' });
			expect(await store.getDecisionExecutionInput('input-implementation')).toMatchObject({ status: 'accepted', workGraphNodeId: 'graph-a:node:implementation' });
			expect(await store.getAgentCapacityPlan('plan-a')).toMatchObject({ status: 'superseded' });
		} finally {
			db.close();
		}
	});
});
