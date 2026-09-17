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
	it('counts shared proposal work through real PostgreSQL graph custody, not only workday-owned nodes', async () => {
		const db = new PGlite();
		try {
			await db.exec(`CREATE TABLE execution_nodes (id text, team_id text, project_id text, workday_id text,
				status text, kind text, source_ref_json jsonb, estimate_json jsonb, required_capabilities_json jsonb);
				INSERT INTO execution_nodes VALUES
				('review','team','project',NULL,'ready','reviewing','{"model":"proposal","id":"golden"}','{"maximumSeconds":300}','["implementation"]'),
				('other-proposal','team','project',NULL,'ready','acting','{"model":"proposal","id":"other"}','{}','["implementation"]'),
				('other-project','team','unselected',NULL,'ready','acting','{"model":"proposal","id":"golden"}','{}','["implementation"]'),
				('other-team','foreign','project',NULL,'ready','acting','{"model":"proposal","id":"golden"}','{}','["implementation"]'),
				('planning','team','project','workday','ready','planning','{}','{}','["implementation"]');`);
			const counts: number[] = [];
			const store = { all: vi.fn(async () => []), first: async (sql: string, values: unknown[]) => {
				let index = 0;
				const row = (await db.query<{ ready_count: number }>(sql.replace(/\?/gu, () => `$${++index}`), values)).rows[0];
				counts.push(Number(row?.ready_count));
				return row ?? null;
			} };
			const selectedRun = { ...run, parameters: { ...run.parameters, proposalIds: ['golden'] } };
			const calculate = (selected: typeof selectedRun) => livingAllocationInputs(store as never, {
				run: selected as never, runs: [selected as never], providers: [provider as never],
				capacityProviderId: 'provider', capabilityId: 'implementation', agentClass: 'reviewer', activity: 'reviewing', now });
			expect((await calculate(selectedRun))['codex-implementation']?.opportunity.availableSeconds).toBe(990);
			expect(counts.at(-1)).toBe(1);
			const planningOnly = { ...selectedRun, parameters: { ...selectedRun.parameters, planningOnly: true } };
			expect((await calculate(planningOnly))['codex-implementation']?.opportunity.availableSeconds).toBe(0);
			await db.exec(`INSERT INTO execution_nodes VALUES
				('report','team','project','workday','ready','reporting','{}','{"maximumSeconds":300}','["implementation"]')`);
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
		expect(query).not.toContain("assignment.status='expired'");
		expect(query).toContain('LIMIT 20');
	});
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
