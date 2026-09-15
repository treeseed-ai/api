import { describe, expect, it, vi } from 'vitest';
import { advanceLivingWorkday } from '../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts';

const now = '2026-09-13T16:00:00.000Z';
const policy = { durationSeconds: 60, maximumConcurrency: 2, planningSecondsPerAgent: 10,
	communicationConcurrency: 1, projectWeights: { project: 1 }, agentClassWeights: { architect: 1 } };
const plan = { schemaVersion: 'treeseed.workday/v1', id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
	executionMode: 'simulation',
	policySnapshot: policy, state: 'active', startsAt: '2026-09-13T15:00:00.000Z', endsAt: '2026-09-13T15:01:00.000Z',
	planningRounds: [{ round: 1, state: 'active', assignmentIds: ['planning:workday:1:project/architect'] },
		{ round: 2, state: 'pending', assignmentIds: ['planning:workday:2:project/architect'] }],
	admittedSecondsByProject: {}, admittedSecondsByAgentClass: {}, activatedAt: '2026-09-13T15:00:00.000Z' } as const;
const run = { id: 'workday', teamId: 'team', status: 'running', completedAt: null,
	parameters: { appliedPlan: plan } } as never;

describe('living workday lifecycle', () => {
	it('completes planning rounds and enters closing without consulting demand or envelope storage', async () => {
		const updateCapacityWorkdayRun = vi.fn(async () => run);
		const store = { all: vi.fn(async (sql: string) => sql.includes('execution_nodes') ? [
			{ id: 'planning:workday:1:project/architect', kind: 'planning', status: 'completed' },
			{ id: 'planning:workday:2:project/architect', kind: 'planning', status: 'completed' },
			{ id: 'reporting:workday:project/reporter', kind: 'reporting', status: 'ready' },
		] : []), updateCapacityWorkdayRun };
		const result = await advanceLivingWorkday(store as never, run, now);
		expect(result.plan).toMatchObject({ state: 'closing', planningRounds: [{ state: 'complete' }, { state: 'complete' }] });
		const sql = store.all.mock.calls.map(([query]) => query).join('\n');
		expect(sql).not.toMatch(/capacity_workday_demands|workday_capacity_envelopes/u);
	});

	it('ends only after Reporter completion and reservation settlement', async () => {
		const closing = { ...plan, state: 'closing', closingAt: now } as const;
		const closingRun = { ...run, parameters: { appliedPlan: closing } } as never;
		const updateCapacityWorkdayRun = vi.fn(async () => closingRun);
		const store = { all: vi.fn(async (sql: string) => sql.includes('execution_nodes')
			? [{ id: 'reporting:workday:project/reporter', kind: 'reporting', status: 'completed' }]
			: [{ state: 'consumed' }]), updateCapacityWorkdayRun };
		const result = await advanceLivingWorkday(store as never, closingRun, now);
		expect(result).toMatchObject({ changed: true, status: 'completed', plan: { state: 'ended', endedAt: now } });
	});
});
