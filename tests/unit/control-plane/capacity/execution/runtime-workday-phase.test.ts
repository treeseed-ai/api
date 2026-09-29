import { describe, expect, it, vi } from 'vitest';
import { compileWorkday } from '@treeseed/sdk/agent-capacity';
import { runtimeWorkdayPhase } from '../../../../../src/api/capacity/services/build/ready-execution-node.ts';

const plan = { ...compileWorkday({ id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
	executionMode: 'simulation', policy: { durationSeconds: 3600, planningPercent: 100 / 3,
		maximumConcurrency: 5, communicationConcurrency: 5 }, agentIds: [],
	startsAt: '2026-09-29T12:00:00Z' }), state: 'active' as const };
const run = { id: 'workday', teamId: 'team', executionKind: 'workday',
	parameters: { appliedPlan: plan, scheduledProjectIds: ['sdk', 'api'] } } as never;

describe('fluid workday phase from the living graph', () => {
	it('keeps the initial planning window even if approved work is ready', async () => {
		const first = vi.fn(async () => ({ id: 'actor' }));
		expect(await runtimeWorkdayPhase({ first } as never, run, '2026-09-29T12:19:59Z')).toBe('planning');
		expect(first).not.toHaveBeenCalled();
	});
	it('continues or resumes planning when no approved acting node is ready', async () => {
		const first = vi.fn(async () => null);
		expect(await runtimeWorkdayPhase({ first } as never, run, '2026-09-29T12:20:00Z')).toBe('planning');
		expect(first).toHaveBeenCalledOnce();
	});
	it('admits acting only when a ready node exists in selected projects', async () => {
		const first = vi.fn(async () => ({ id: 'actor' }));
		expect(await runtimeWorkdayPhase({ first } as never, run, '2026-09-29T12:20:00Z')).toBe('acting');
		expect(first.mock.calls[0]?.[0]).toContain("node.kind IN ('acting','reviewing')");
	});
	it('never revives a workday after its hard end', async () => {
		const first = vi.fn(async () => ({ id: 'actor' }));
		expect(await runtimeWorkdayPhase({ first } as never, run, plan.endsAt)).toBe('ended');
		expect(first).not.toHaveBeenCalled();
	});
});
