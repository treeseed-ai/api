import { describe,expect,it,vi } from 'vitest';
import { fenceCapacityWorkdayAdmission } from '../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-admission-fence-service.ts';

describe('workday admission fence service',() => {
	it('closes admission before reading authoritative assignment and settlement state',async () => {
		const order: string[] = [];
		const first = vi.fn(async (query: string) => {
			if (query.includes('capacity_workday_runs')) return { id: 'run-a',status: 'running' };
			order.push(query.includes('workday_capacity_envelopes') ? 'envelopes' : query.includes('agent_mode_runs') ? 'mode-runs' : 'assignments');
			if (query.includes('workday_capacity_envelopes')) return { total: 1,active: 0 };
			if (query.includes('agent_mode_runs')) return { total: 2,failed: 0,non_terminal: 0 };
			return { total: 2,completed: 2,failed: 0,non_terminal: 0,unsettled: 0 };
		});
		const store = {
			first,
			all: vi.fn(async () => []),
			closeCapacityWorkdayAdmission: vi.fn(async () => { order.push('close'); return { closed: 1 }; }),
		};
		await expect(fenceCapacityWorkdayAdmission(store as never,'team-a','run-a')).resolves.toMatchObject({
			ready: true,successful: true,closedEnvelopes: 1,
			assignments: { total: 2,completed: 2,failed: 0,nonTerminal: 0,unsettled: 0 },
		});
		expect(order[0]).toBe('close');
		const queries = first.mock.calls.map(([query]) => query);
		expect(queries.find((query) => query.includes('FROM agent_mode_runs'))).toContain("recordKind");
		expect(queries.find((query) => query.includes('FROM capacity_provider_assignments assignment'))).not.toContain('mode_run.metadata_json');
	});

	it('is replay-safe and refuses success when a late assignment failed or lacks settlement',async () => {
		const store = {
			first: vi.fn()
				.mockResolvedValueOnce({ id: 'run-a',status: 'running' })
				.mockResolvedValueOnce({ total: 1,active: 0 })
				.mockResolvedValueOnce({ total: 2,completed: 1,failed: 1,non_terminal: 0,unsettled: 1 })
				.mockResolvedValueOnce({ total: 2,failed: 1,non_terminal: 0 }),
			all: vi.fn(async () => [{ id: 'assignment-late',status: 'failed' }]),
			closeCapacityWorkdayAdmission: vi.fn(async () => ({ closed: 0 })),
		};
		await expect(fenceCapacityWorkdayAdmission(store as never,'team-a','run-a')).resolves.toMatchObject({
			ready: false,successful: false,closedEnvelopes: 0,problemAssignmentIds: ['assignment-late'],
		});
	});

	it('refuses readiness while a completed conversation awaits exact content integration',async () => {
		const first = vi.fn(async (query: string) => {
			if (query.includes('capacity_workday_runs')) return { id:'run-a',status:'running' };
			if (query.includes('workday_capacity_envelopes')) return { total:1,active:0 };
			if (query.includes('agent_mode_runs')) return { total:1,failed:0,non_terminal:0 };
			return { total:1,completed:0,failed:0,non_terminal:1,unsettled:0 };
		});
		const store = {
			first,
			all: vi.fn(async () => [{ id:'assignment-chat',status:'completed' }]),
			closeCapacityWorkdayAdmission: vi.fn(async () => ({ closed:1 })),
		};
		await expect(fenceCapacityWorkdayAdmission(store as never,'team-a','run-a')).resolves.toMatchObject({
			ready:false,successful:true,problemAssignmentIds:['assignment-chat'],
			assignments:{ total:1,completed:0,nonTerminal:1 },
		});
		const assignmentQuery=first.mock.calls.map(([query])=>query)
			.find((query)=>query.includes('FROM capacity_provider_assignments assignment'))??'';
		expect(assignmentQuery).toContain("event_type = 'assignment.content.integrated'");
	});

	it('refuses readiness while any completed mutation assignment awaits exact integration',async () => {
		const first = vi.fn(async (query: string) => {
			if (query.includes('capacity_workday_runs')) return { id:'run-a',status:'running' };
			if (query.includes('workday_capacity_envelopes')) return { total:1,active:0 };
			if (query.includes('agent_mode_runs')) return { total:1,failed:0,non_terminal:0 };
			return { total:1,completed:0,failed:0,non_terminal:1,unsettled:0 };
		});
		const store = { first,all:vi.fn(async()=>[{id:'assignment-planning',status:'completed'}]),closeCapacityWorkdayAdmission:vi.fn(async()=>({closed:1})) };
		await expect(fenceCapacityWorkdayAdmission(store as never,'team-a','run-a')).resolves.toMatchObject({ ready:false,problemAssignmentIds:['assignment-planning'] });
		const query=first.mock.calls.map(([candidate])=>candidate).find((candidate)=>candidate.includes('FROM capacity_provider_assignments assignment'))??'';
		expect(query).toContain("event_type = 'assignment.content.integration_required'");
		expect(query).toContain('integration_required.id IS NULL');
	});
});
