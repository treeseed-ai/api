import { describe, expect, it, vi } from 'vitest';
import { compileWorkday } from '@treeseed/sdk/agent-capacity';
import { CapacityWorkdayRunRepository } from '../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';

describe('workday admission read-back', () => {
	it('derives project and class receipt totals from team-scoped reservations without storing duplicate counters', async () => {
		const now = '2026-09-16T12:00:00.000Z';
		const plan = compileWorkday({ id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', startsAt: now, agentIds: [], policy: { durationSeconds: 600,
				maximumConcurrency: 1, communicationConcurrency: 1 } });
		const row = { id: 'workday', team_id: 'team', scenario_id: 'profile:default', status: 'running', environment: 'local',
			execution_kind: 'workday', trigger_kind: 'manual', execution_mode: 'simulation', parameters_json: JSON.stringify({ appliedPlan: plan }),
			summary_json: '{}', metrics_json: '{}', expected_json: '{}', actual_json: '{}', report_refs_json: '{}', error_json: '{}',
			created_at: now, updated_at: now };
		const all = vi.fn(async (_query: string, _values: unknown[]) => [
			{ project_id: 'sdk', agent_class: 'engineer', admitted_seconds: '180' },
			{ project_id: 'sdk', agent_class: 'tester', admitted_seconds: '90' },
		]);
		const database = { ensureInitialized: vi.fn(), first: vi.fn(async () => row), all };
		const run = await new CapacityWorkdayRunRepository(database as never).get('team', 'workday');
		expect(run?.parameters.appliedPlan).toMatchObject({ admittedSecondsByProject: { sdk: 270 },
			admittedSecondsByAgentClass: { 'sdk:engineer': 180, 'sdk:tester': 90 } });
		expect(all.mock.calls[0]![0]).toContain('reservation.team_id=? AND reservation.work_day_id=?');
		expect(all.mock.calls[0]![1]).toEqual(['team', 'workday']);
		expect(plan.admittedSecondsByProject).toEqual({});
	});
});
