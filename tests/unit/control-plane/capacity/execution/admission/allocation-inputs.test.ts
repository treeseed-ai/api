import { describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { livingAllocationInputs } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-allocation-inputs.ts';

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
		expect(store.first.mock.calls[0]?.[0]).toContain("node.kind='communication'");
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
			expect((await calculate(selectedRun, '2026-09-16T12:10:00.000Z'))['codex-implementation']?.opportunity.availableSeconds).toBe(198);
			expect(counts.at(-1)).toBe(2);
			// After the phase boundary, only the selected Actor and its paired
			// Reviewer remain eligible; proposal governance review no longer counts.
			expect((await calculate(selectedRun))['codex-implementation']?.opportunity.availableSeconds).toBe(990);
			expect(counts.at(-1)).toBe(2);
			const planningOnly = { ...selectedRun, parameters: { ...selectedRun.parameters, planningOnly: true } };
			expect((await calculate(planningOnly, '2026-09-16T12:10:00.000Z'))['codex-implementation']?.opportunity.availableSeconds).toBe(198);
			// Governance review is planning work, not implementation. A planning-only
			// run must retain that node as well as its ordinary planning turn.
			expect(counts.at(-1)).toBe(2);
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
		expect(query).toContain("node.status='completed' AND assignment.execution_node_revision=node.node_revision");
		expect(query).not.toContain("assignment.status='expired'");
		expect(query).toContain('LIMIT 20');
	});
	it('does not learn a short success from an Actor attempt rejected by review', async () => {
		const db = new PGlite();
		try {
			await db.exec(`CREATE TABLE execution_nodes (id text, team_id text, agent_class text, pair_role text, status text, node_revision integer);
				CREATE TABLE capacity_provider_assignments (id text, team_id text, execution_node_id text, execution_node_revision integer,
					capacity_provider_id text, execution_provider_id text, status text, lifecycle_code text, assignment_attempt_json jsonb);
				CREATE TABLE capacity_usage_actuals (id text, assignment_id text, created_at text, active_seconds integer, accounting_mode text);
				INSERT INTO execution_nodes VALUES ('accepted','team','tester','actor','completed',2),('rejected','team','tester','actor','failed',2);
				INSERT INTO capacity_provider_assignments VALUES
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
			const store = { all: async (sql: string, values: unknown[]) => {
				if (!sql.includes('capacity_usage_actuals')) return [];
				let index = 0;
				return (await db.query(sql.replace(/\?/gu, () => `$${++index}`), values)).rows;
			}, first: async () => ({ ready_count: 1 }) };
			const result = await livingAllocationInputs(store as never, { run: run as never, runs: [run as never],
				providers: [provider as never], capacityProviderId: 'provider', capabilityId: 'implementation',
				agentClass: 'tester', activity: 'act', now });
			expect(result['codex-implementation']?.measurements.map(({ id }) => id)).toEqual(['expired', 'accepted']);
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
