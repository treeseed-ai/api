import { describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { livingAllocationInputs } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-allocation-inputs.ts';
import { postgresGraph } from '../graph/architecture/living/living-postgres-fixture.ts';
import { serializeCapacityWorkdayRunRow } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
import { DEFAULT_WORKDAY_POLICY, compileWorkday } from '@treeseed/sdk/agent-capacity';

const now = '2026-09-16T12:30:00.000Z';
const plan = { schemaVersion: 'treeseed.workday/v1', id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
	executionMode: 'simulation', state: 'active', startsAt: '2026-09-16T12:00:00.000Z', endsAt: '2026-09-16T14:00:00.000Z',
	policySnapshot: { durationSeconds: 7200, maximumConcurrency: 1, communicationConcurrency: 1, planningPercent: 20,
		allocationWeight: 1, planningTurnMaximumSeconds: 180, projectPercentages: { project: 100 },
		agentClassPercentages: { project: { engineer: 100 } } }, planningRounds: [],
	admittedSecondsByProject: {}, admittedSecondsByAgentClass: {} };
const run = { id: 'workday', teamId: 'team', parameters: { appliedPlan: plan, scheduledProjectIds: ['project'] } };
const observation = { day: '2026-09-16', observedAt: now, healthy: true, activeSeconds: 10, reservedSeconds: 0 };
const provider = { id: 'codex-implementation', accountingLimits: { modelConfigurationId: 'terra-medium',
	dailyActiveSecondsLimit: 1000, capabilityLimits: { implementation: { dailyActiveSecondsLimit: 1000 } } },
	accountingObservation: { modelUsage: observation, capabilityUsage: { implementation: observation } } };

describe('live allocation ledger inputs', () => {
	it('native independent PostgreSQL readers retain committed seconds while weighted opportunity follows only exact ready graph demand across simulation and production', async () => {
		const f = await postgresGraph();
		try {
			const at = new Date().toISOString(), startsAt = new Date(Date.parse(at) - 20_000).toISOString();
			const database = (db: typeof f.left) => ({ db, ensureInitialized: () => db.migrate(),
				run: async (sql: string, params: unknown[] = []) => { await db.prepare(sql).bind(...params).run(); },
				first: (sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params).first(),
				all: async (sql: string, params: unknown[] = []) => (await db.prepare(sql).bind(...params).all()).results,
				batch: (operations: Array<{ query: string; params?: unknown[] }>) => db.batch(operations) });
			await f.left.pool.query(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project','team','allocation','Allocation',$1,$1)`, [at]);
			await f.left.pool.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,created_at,updated_at) VALUES ('class','team','project','renamed-author','Renamed author',$1,$1)`, [at]);
			await f.left.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES ('provider','controlled','{}','Controlled supply',$1,$1)`, [at]);
			await f.left.pool.query(`INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at) VALUES ('membership','team','provider',$1,'controlled-input',$1,$1)`, [at]);
			await f.left.pool.query(`INSERT INTO capacity_execution_providers (id,capacity_provider_id,display_name,adapter,native_unit,max_concurrent_runners,created_at,updated_at) VALUES ('configured-executor','provider','Configured executor','codex','seconds',1,$1,$1)`, [at]);
			for (const [id, weight, ready] of [['a', 2, true], ['b', 1, true], ['idle', 10, false]] as const) {
				const applied = { ...compileWorkday({ id, teamId: 'team', policyId: 'default', policyRevision: 1,
					executionMode: id === 'b' ? 'production' : 'simulation', policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 60, maximumConcurrency: 1,
						communicationConcurrency: 1, planningPercent: 20, allocationWeight: weight }, agentIds: [], startsAt }), state: 'active' as const };
				await f.left.pool.query(`INSERT INTO capacity_workday_runs (id,team_id,scenario_id,status,execution_mode,execution_kind,
					parameters_json,started_at,created_at,updated_at) VALUES ($1,'team','weighted-input','running',$2,'workday',$3,$4,$4,$4)`,
					[id, applied.executionMode, JSON.stringify({ appliedPlan: applied, scheduledProjectIds: ['project'] }), at]);
				await f.left.pool.query(`INSERT INTO execution_nodes (id,team_id,project_id,workday_id,kind,source_ref_json,rule_revision,
					node_revision,agent_class,status,estimate_json,required_capabilities_json,graph_revision_created,graph_revision_updated,created_at,updated_at)
					VALUES ($1,'team','project',$2,'planning','{}',1,1,'renamed-author',$3,$4,'["implementation"]',1,1,$5,$5)`,
					[`node-${id}`, id, ready ? 'ready' : 'blocked', JSON.stringify({ expectedSeconds: 2, maximumSeconds: 3 }), at]);
			}
			await f.left.pool.query(`INSERT INTO capacity_provider_assignments (id,membership_id,team_id,project_id,capacity_provider_id,
				execution_provider_id,project_agent_class_id,work_day_id,mode,status,assignment_attempt_json,created_at,updated_at)
				VALUES ('prior','membership','team','project','provider','configured-executor','class','a','planning','running',$1,$2,$2)`,
				[JSON.stringify({ provider: { modelConfigurationId: 'shared-model', executionCapabilityId: 'implementation' } }), at]);
			await f.left.pool.query(`INSERT INTO capacity_reservations (id,idempotency_key,admission_token,membership_id,capacity_provider_id,
				project_agent_class_id,assignment_id,mode,team_id,project_id,work_day_id,state,requested_seconds,reserved_seconds,active_seconds,created_at,updated_at)
				VALUES ('prior-reservation','prior-reservation','controlled-admission','membership','provider','class','prior','planning','team','project','a','reserved',4,4,0,$1,$1)`, [at]);
			const observation = { day: at.slice(0, 10), observedAt: at, healthy: true, activeSeconds: 0, reservedSeconds: 0 };
			const selected: Parameters<typeof livingAllocationInputs>[1]['providers'] = [{ id: 'configured-executor', runtimeBuild: `sha256:${'f'.repeat(64)}`,
				status: 'available', capabilities: ['implementation'], maxConcurrentRunners: 1, lanes: [], offers: [],
				accountingLimits: { modelConfigurationId: 'shared-model', dailyActiveSecondsLimit: 12, capabilityLimits: { implementation: { dailyActiveSecondsLimit: 12 } } },
				accountingObservation: { modelUsage: observation, capabilityUsage: { implementation: observation } } }];
			const tables = ['capacity_workday_runs', 'execution_nodes', 'execution_edges', 'capacity_provider_assignments', 'capacity_reservations', 'capacity_usage_actuals', 'capacity_ledger_entries'];
			const snapshot = async (db: typeof f.left) => Promise.all(tables.map(async table =>
				(await db.pool.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows));
			const calculate = async (db: typeof f.left, reverse = false) => {
				const rows = (await db.pool.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows;
				const runs = rows.map(value => { const run = serializeCapacityWorkdayRunRow(value); if (!run) throw new Error('Original stored workday required'); return run; });
				const output: Record<string, number> = {};
				for (const run of runs) {
					const input = { run, runs: reverse ? [...runs].reverse() : runs, providers: selected, capacityProviderId: 'provider',
						capabilityId: 'implementation', agentClass: 'renamed-author', activity: 'planning', now: at }, before = structuredClone(input);
					const result = (await livingAllocationInputs(database(db), input))['configured-executor']!;
					expect(result.opportunity.committedSeconds).toBe(run.id === 'a' ? 4 : 0);
					expect(result.opportunity.remainingSupplySeconds).toBe(8); expect(input).toEqual(before);
					output[run.id] = result.opportunity.availableSeconds;
				}
				return output;
			};
			const baseline = await snapshot(f.left); expect(await snapshot(f.right)).toEqual(baseline);
			for (const value of await Promise.all([calculate(f.left), calculate(f.right, true)])) expect(value).toEqual({ a: 4, b: 4, idle: 0 });
			expect(await snapshot(f.left)).toEqual(baseline); expect(await snapshot(f.right)).toEqual(baseline);
			await f.left.pool.query("UPDATE execution_nodes SET status='ready' WHERE id='node-idle'");
			const expanded = await snapshot(f.right);
			for (const value of await Promise.all([calculate(f.left, true), calculate(f.right)])) expect(value).toEqual({ a: 0, b: 1, idle: 7 });
			expect(await snapshot(f.left)).toEqual(expanded); expect(await snapshot(f.right)).toEqual(expanded);
			expect((await f.right.pool.query("SELECT reserved_seconds,active_seconds,state FROM capacity_reservations WHERE id='prior-reservation'")).rows)
				.toEqual([{ reserved_seconds: 4, active_seconds: 0, state: 'reserved' }]);
			// Native original SQL/allocator with supplied readiness and reservation
			// facts, not accepted-decision production, actual models or global fairness.
		} finally { await f.close(); }
	}, 30_000);
	it('sizes chat opportunities against communication concurrency and only chat-ready graph nodes', async () => {
		const at = '2026-09-16T13:55:00.000Z';
		const store = { all: vi.fn(async () => []), first: vi.fn(async () => ({ ready_count: 1 })) };
		const chatRun = { ...run, parameters: { ...run.parameters, appliedPlan: { ...plan,
			policySnapshot: { ...plan.policySnapshot, communicationConcurrency: 2 } } } };
		const chatProvider = { ...provider, accountingObservation: { modelUsage: { ...observation, observedAt: at },
			capabilityUsage: { implementation: { ...observation, observedAt: at } } } };
		const result = await livingAllocationInputs(store as never, { run: chatRun as never,
			runs: [chatRun as never], providers: [chatProvider as never], capacityProviderId: 'provider',
			capabilityId: 'implementation', agentClass: 'architect', activity: 'chat', now: at });
		expect(result['codex-implementation']?.opportunity.availableSeconds).toBe(600);
		expect(store.first.mock.calls.some(([sql]) => String(sql).includes("node.kind='communication'"))).toBe(true);
	});
	it('counts shared proposal work through real PostgreSQL graph custody, not only workday-owned nodes', async () => {
		const db = new PGlite();
		try {
			await db.exec(`CREATE TABLE execution_nodes (id text, team_id text, project_id text, workday_id text,
				status text, kind text, pair_role text, source_ref_json jsonb, estimate_json jsonb, required_capabilities_json jsonb);
				INSERT INTO execution_nodes VALUES
				('review','team','project',NULL,'ready','reviewing',NULL,'{"model":"proposal","id":"golden"}','{"maximumSeconds":300}','["implementation"]'),
				('other-proposal','team','project',NULL,'ready','acting',NULL,'{"model":"proposal","id":"other"}','{}','["implementation"]'),
				('other-project','team','unselected',NULL,'ready','acting',NULL,'{"model":"proposal","id":"golden"}','{}','["implementation"]'),
				('other-team','foreign','project',NULL,'ready','acting',NULL,'{"model":"proposal","id":"golden"}','{}','["implementation"]'),
				('selected-actor','team','project',NULL,'ready','acting','actor','{"model":"proposal","id":"golden"}','{}','["implementation"]'),
				('selected-paired-review','team','project',NULL,'ready','reviewing','reviewer','{"model":"proposal","id":"golden"}','{}','["implementation"]'),
				('planning','team','project','workday','ready','planning',NULL,'{}','{}','["implementation"]');`);
			const counts: number[] = [];
			const store = { all: vi.fn(async () => []), first: async (sql: string, values: unknown[]) => {
				if (sql.includes('SELECT node.id FROM execution_nodes')) return { id: 'selected-actor' };
				let index = 0;
				const row = (await db.query<{ ready_count: number }>(sql.replace(/\?/gu, () => `$${++index}`), values)).rows[0];
				counts.push(Number(row?.ready_count));
				return row ?? null;
			} };
			const selectedRun = { ...run, parameters: { ...run.parameters, proposalIds: ['golden'] } };
			const calculate = (selected: typeof selectedRun, at = now) => livingAllocationInputs(store as never, {
				run: selected as never, runs: [selected as never], providers: [{ ...provider, accountingObservation: {
					modelUsage: { ...observation, observedAt: at },
					capabilityUsage: { implementation: { ...observation, observedAt: at } },
				} } as never],
				capacityProviderId: 'provider', capabilityId: 'implementation', agentClass: 'reviewer', activity: 'reviewing', now: at });
			expect((await calculate(selectedRun, '2026-09-16T12:10:00.000Z'))['codex-implementation']?.opportunity.availableSeconds).toBe(990);
			expect(counts.at(-1)).toBe(1);
			// Acting capacity is available to selected accepted Actor/Reviewer pairs.
			expect((await calculate(selectedRun))['codex-implementation']?.opportunity.availableSeconds).toBe(990);
			expect(counts.at(-1)).toBe(2);
			const planningOnly = { ...selectedRun, parameters: { ...selectedRun.parameters, planningOnly: true } };
			expect((await calculate(planningOnly, '2026-09-16T12:10:00.000Z'))['codex-implementation']?.opportunity.availableSeconds).toBe(990);
			expect(counts.at(-1)).toBe(1);
			await db.exec(`INSERT INTO execution_nodes VALUES
				('report','team','project','workday','ready','reporting',NULL,'{}','{"maximumSeconds":300}','["implementation"]')`);
			const closing = { ...selectedRun, parameters: { ...selectedRun.parameters,
				appliedPlan: { ...plan, state: 'closing' } } };
			expect((await calculate(closing))['codex-implementation']?.opportunity.availableSeconds).toBe(300);
			expect(counts.at(-1)).toBe(1);
		} finally { await db.close(); }
	}, 15_000);
	it('retains unattributed historical consumption against model supply, not an invented capability', async () => {
		const store = { all: vi.fn(async (sql: string) => sql.includes('capacity_reservations') ? [
			{ work_day_id: 'historical', mode: 'acting', state: 'consumed', reserved_seconds: 300, active_seconds: 300, capability_id: null },
		] : []), first: vi.fn(async () => ({ ready_count: 1 })) };
		const result = await livingAllocationInputs(store as never, { run: run as never, runs: [run as never], providers: [provider as never],
			capacityProviderId: 'provider', capabilityId: 'implementation', agentClass: 'engineer', activity: 'act', now });
		expect(result['codex-implementation']?.constraints[0]?.remainingSeconds).toBe(700);
		expect(result['codex-implementation']?.opportunity).toMatchObject({ weight: 1, totalEligibleWeight: 1,
			committedSeconds: 0, remainingSupplySeconds: 700, shareSeconds: 700, phase: 'acting', availableSeconds: 700 });
		expect(store.all.mock.calls[0]![0]).toContain("NULLIF(assignment.assignment_attempt_json::jsonb->'provider'->>'modelConfigurationId','') IS NULL");
	});
	it('calibrates productive deadline expiration, not uncertain lease recovery', async () => {
		const store = { all: vi.fn(async (sql: string) => sql.includes('capacity_usage_actuals') ? [
			{ id: 'usage', created_at: now, active_seconds: 180, expected_seconds: 120, allocated_seconds: 180,
				status: 'failed', lifecycle_code: 'assignment_timeout' },
		] : []), first: vi.fn(async () => ({ ready_count: 1 })) };
		const result = await livingAllocationInputs(store as never, { run: run as never, runs: [run as never], providers: [provider as never],
			capacityProviderId: 'provider', capabilityId: 'implementation', agentClass: 'engineer', activity: 'act', now });
		expect(result['codex-implementation']?.measurements[0]?.outcome).toBe('expired');
		const query = store.all.mock.calls.find(([sql]) => sql.includes('capacity_usage_actuals'))![0];
		expect(query).toContain("assignment.lifecycle_code='assignment_timeout'");
		expect(query).toContain("node.pair_role IS DISTINCT FROM 'actor'");
		expect(query).toContain("{activityCompletion,reviewDisposition}'='approved'");
		expect(query).toContain("'predecessorResultIds'");
		expect(query).not.toContain("node.status='completed' AND assignment.execution_node_revision=node.node_revision");
		expect(query).not.toContain("assignment.status='expired'");
		expect(query).toContain('LIMIT 20');
	});
	it('retains only exact approved Actor history after graph retirement', async () => {
		const db = new PGlite();
		try {
			await db.exec(`CREATE TABLE execution_nodes (id text, team_id text, agent_class text, pair_role text, status text, node_revision integer,
				kind text DEFAULT 'acting', source_ref_json jsonb DEFAULT '{}');
				CREATE TABLE execution_edges (team_id text,from_node_id text,to_node_id text,provenance text);
				INSERT INTO execution_edges VALUES ('team','accepted','review-node','review-pair'),
					('team','rejected','rejection-node','review-pair'),('team','rejected','wrong-pair-node','review-pair');
				CREATE TABLE capacity_provider_assignments (id text, team_id text, execution_node_id text, execution_node_revision integer,
					capacity_provider_id text, execution_provider_id text, status text, lifecycle_code text, assignment_attempt_json jsonb,
					assignment_result_json jsonb DEFAULT NULL, lifecycle_output_json jsonb DEFAULT NULL);
				CREATE TABLE capacity_usage_actuals (id text, assignment_id text, created_at text, active_seconds integer, accounting_mode text);
				INSERT INTO execution_nodes (id,team_id,agent_class,pair_role,status,node_revision) VALUES
				('accepted','team','tester','actor','completed',2),('rejected','team','tester','actor','failed',2);
				INSERT INTO capacity_provider_assignments (id,team_id,execution_node_id,execution_node_revision,
					capacity_provider_id,execution_provider_id,status,lifecycle_code,assignment_attempt_json) VALUES
				('old','team','accepted',1,'provider','codex-implementation','completed',NULL,
				 '{"estimate":{"expectedSeconds":360},"limits":{"maximumSeconds":360},"provider":{"modelConfigurationId":"terra-medium","executionCapabilityId":"implementation"},"effectiveProfile":{"activity":"act"}}'),
				('accepted','team','accepted',2,'provider','codex-implementation','completed',NULL,
				 '{"estimate":{"expectedSeconds":360},"limits":{"maximumSeconds":600},"provider":{"modelConfigurationId":"terra-medium","executionCapabilityId":"implementation"},"effectiveProfile":{"activity":"act"}}'),
				('rejected','team','rejected',1,'provider','codex-implementation','completed',NULL,
				 '{"estimate":{"expectedSeconds":360},"limits":{"maximumSeconds":360},"provider":{"modelConfigurationId":"terra-medium","executionCapabilityId":"implementation"},"effectiveProfile":{"activity":"act"}}'),
				('expired','team','rejected',2,'provider','codex-implementation','failed','assignment_timeout',
				 '{"estimate":{"expectedSeconds":360},"limits":{"maximumSeconds":385},"provider":{"modelConfigurationId":"terra-medium","executionCapabilityId":"implementation"},"effectiveProfile":{"activity":"act"}}');
				INSERT INTO capacity_usage_actuals VALUES
				('old','old','2026-09-16T12:01:00Z',180,'aggregate'),
				('accepted','accepted','2026-09-16T12:02:00Z',500,'aggregate'),
				('rejected','rejected','2026-09-16T12:03:00Z',180,'aggregate'),
				('expired','expired','2026-09-16T12:04:00Z',385,'aggregate');`);
			await db.exec(`UPDATE capacity_provider_assignments SET assignment_result_json=jsonb_build_object('id','result:'||id);
				INSERT INTO capacity_provider_assignments (id,team_id,execution_node_id,status,assignment_attempt_json,lifecycle_output_json) VALUES
				('review','team','review-node','completed','{"predecessorResultIds":["result:accepted"]}',
				 '{"activityCompletion":{"reviewDisposition":"approved"}}'),
				('rejection','team','rejection-node','completed','{"predecessorResultIds":["result:rejected"]}',
				 '{"activityCompletion":{"reviewDisposition":"request-changes"}}'),
				('wrong-team','foreign','review-node','completed','{"predecessorResultIds":["result:old"]}',
				 '{"activityCompletion":{"reviewDisposition":"approved"}}'),
				('wrong-pair','team','wrong-pair-node','completed','{"predecessorResultIds":["result:old"]}',
				 '{"activityCompletion":{"reviewDisposition":"approved"}}');
				UPDATE capacity_provider_assignments SET assignment_result_json=jsonb_build_object('id','result:'||id)
				WHERE assignment_result_json IS NULL;`);
			const store = { all: async (sql: string, values: unknown[]) => {
				if (!sql.includes('capacity_usage_actuals')) return [];
				let index = 0;
				return (await db.query(sql.replace(/\?/gu, () => `$${++index}`), values)).rows;
			}, first: async () => ({ ready_count: 1 }) };
			const calculate = () => livingAllocationInputs(store as never, { run: run as never, runs: [run as never],
				providers: [provider as never], capacityProviderId: 'provider', capabilityId: 'implementation',
				agentClass: 'tester', activity: 'act', now });
			expect((await calculate())['codex-implementation']?.measurements.map(({ id }) => id)).toEqual(['expired', 'accepted']);
			// Retirement changes graph state, never the prior exact-candidate approval.
			await db.exec("UPDATE execution_nodes SET status='stale',node_revision=node_revision+1");
			expect((await calculate())['codex-implementation']?.measurements.map(({ id }) => id)).toEqual(['expired', 'accepted']);
		} finally { await db.close(); }
	}, 15_000);
	it('uses only proposal-governance history for proposal reviews, never paired-review duration', async () => {
		const db = new PGlite();
		try {
			await db.exec(`CREATE TABLE execution_nodes (id text, team_id text, agent_class text, pair_role text,
				kind text, source_ref_json jsonb, status text, node_revision integer);
				CREATE TABLE execution_edges (team_id text,from_node_id text,to_node_id text,provenance text);
				CREATE TABLE capacity_provider_assignments (id text, team_id text, execution_node_id text,
					capacity_provider_id text, execution_provider_id text, status text, lifecycle_code text,
					assignment_attempt_json jsonb, execution_node_revision integer,
					assignment_result_json jsonb DEFAULT NULL, lifecycle_output_json jsonb DEFAULT NULL);
				CREATE TABLE capacity_usage_actuals (id text, assignment_id text, created_at text, active_seconds integer, accounting_mode text);
				INSERT INTO execution_nodes VALUES
				('governance','team','reviewer',NULL,'reviewing','{"model":"proposal"}','completed',1),
				('paired','team','reviewer','reviewer','reviewing','{"model":"proposal"}','completed',1);
				INSERT INTO capacity_provider_assignments (id,team_id,execution_node_id,capacity_provider_id,
					execution_provider_id,status,lifecycle_code,assignment_attempt_json,execution_node_revision) VALUES
				('governance','team','governance','provider','codex-implementation','completed',NULL,
				 '{"estimate":{"expectedSeconds":250},"limits":{"maximumSeconds":165},"provider":{"modelConfigurationId":"terra-medium","executionCapabilityId":"implementation"},"effectiveProfile":{"activity":"reviewing"}}',1),
				('paired','team','paired','provider','codex-implementation','completed',NULL,
				 '{"estimate":{"expectedSeconds":250},"limits":{"maximumSeconds":165},"provider":{"modelConfigurationId":"terra-medium","executionCapabilityId":"implementation"},"effectiveProfile":{"activity":"reviewing"}}',1);
				INSERT INTO capacity_usage_actuals VALUES
				('governance','governance','2026-09-16T12:01:00Z',84,'aggregate'),
				('paired','paired','2026-09-16T12:02:00Z',15,'aggregate');`);
			const store = { all: async (sql: string, values: unknown[]) => {
				if (!sql.includes('capacity_usage_actuals')) return [];
				let index = 0;
				return (await db.query(sql.replace(/\?/gu, () => `$${++index}`), values)).rows;
			}, first: async () => ({ ready_count: 1 }) };
			const base = { run: run as never, runs: [run as never], providers: [provider as never],
				capacityProviderId: 'provider', capabilityId: 'implementation', agentClass: 'reviewer', activity: 'reviewing', now };
			expect((await livingAllocationInputs(store as never, { ...base, proposalGovernanceReview: true }))
				['codex-implementation']?.measurements.map(({ id }) => id)).toEqual(['governance']);
			expect((await livingAllocationInputs(store as never, { ...base, proposalGovernanceReview: false }))
				['codex-implementation']?.measurements.map(({ id }) => id)).toEqual(['paired']);
		} finally { await db.close(); }
	}, 15_000);
	it('does not exempt closing workdays from shared supply and weighted allocation', async () => {
		const closingRun = { ...run, parameters: { appliedPlan: { ...plan, state: 'closing' } } };
		const store = { all: vi.fn(async () => []), first: vi.fn(async () => ({ ready_count: 1 })) };
		const result = await livingAllocationInputs(store as never, { run: closingRun as never, runs: [closingRun as never],
			providers: [provider as never], capacityProviderId: 'provider', capabilityId: 'implementation',
			agentClass: 'engineer', activity: 'review', now });
		expect(result['codex-implementation']?.constraints).toHaveLength(1);
		expect(result['codex-implementation']?.constraints[0]?.remainingSeconds).toBeLessThanOrEqual(990);
	});
	it('counts unreported API reservations once and includes other capabilities in the shared model budget', async () => {
		const store = { all: vi.fn(async (sql: string) => sql.includes('capacity_reservations') ? [
			{ work_day_id: 'other', mode: 'acting', state: 'consuming', reserved_seconds: 300, active_seconds: 100, capability_id: 'implementation' },
			{ work_day_id: 'other', mode: 'acting', state: 'consumed', reserved_seconds: 500, active_seconds: 200, capability_id: 'analysis' },
		] : []), first: vi.fn(async () => ({ ready_count: 1 })) };
		const result = await livingAllocationInputs(store as never, { run: run as never, runs: [run as never], providers: [provider as never],
			capacityProviderId: 'provider', capabilityId: 'implementation', agentClass: 'engineer', activity: 'act', now });
		expect(result['codex-implementation']?.constraints).toEqual([{ id: 'workday-phase-share', remainingSeconds: 500 }]);
		expect(store.all.mock.calls.filter(([sql]) => sql.includes('capacity_reservations'))).toHaveLength(1);
	});
	it('uses the greater provider total rather than adding duplicate observed consumption', async () => {
		const store = { all: vi.fn(async () => []), first: vi.fn(async () => ({ ready_count: 1 })) };
		const result = await livingAllocationInputs(store as never, { run: run as never, runs: [run as never],
			providers: [{ ...provider, accountingObservation: { modelUsage: { ...observation, activeSeconds: 300, reservedSeconds: 200 },
				capabilityUsage: { implementation: observation } } } as never], capacityProviderId: 'provider', capabilityId: 'implementation',
			agentClass: 'engineer', activity: 'act', now });
		expect(result['codex-implementation']?.constraints[0]?.remainingSeconds).toBe(500);
	});
});
