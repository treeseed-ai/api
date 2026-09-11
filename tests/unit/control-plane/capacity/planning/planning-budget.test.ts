import { describe, expect, it } from 'vitest';
import { boundedPlanningParticipants, planningInstanceTimebox } from '../../../../../src/api/capacity/policy/workdays/planning-budget.ts';
import { compileCooperativePlanningSession, initializeCooperativePlanningSession } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/cooperative-planning-session-service.ts';

const participants = (count: number) => Array.from({ length: count }, (_, i) => ({ nodeId: `node-${String(i).padStart(2, '0')}`, timeboxSeconds: 900 }));
describe('bounded cooperative planning', () => {
	it('fits thirty profile maxima into the declared allocation rather than reserving 27000 seconds', () => {
		const result = boundedPlanningParticipants(participants(30), 120);
		expect(result).toHaveLength(30); expect(result.every(item => item.timeboxSeconds === 4)).toBe(true);
	});
	it('preserves small caps and redistributes unused budget deterministically', () => {
		const input = [{ nodeId: 'c', timeboxSeconds: 900 }, { nodeId: 'a', timeboxSeconds: 1 }, { nodeId: 'b', timeboxSeconds: 900 }];
		expect(boundedPlanningParticipants(input, 10)).toEqual([{ nodeId: 'c', timeboxSeconds: 4 }, { nodeId: 'a', timeboxSeconds: 1 }, { nodeId: 'b', timeboxSeconds: 5 }]);
		expect(boundedPlanningParticipants([...input].reverse(), 10).reverse()).toEqual(boundedPlanningParticipants(input, 10));
		expect(input[0]!.timeboxSeconds).toBe(900);
	});
	it('rejects too-small budgets without dropping participants or rounding above allocation', () => {
		expect(() => boundedPlanningParticipants(participants(30), 24)).toThrow('at least one productive second');
		for (const value of [NaN, Infinity, -1, 1.5]) expect(() => boundedPlanningParticipants(participants(1), value)).toThrow();
		expect(boundedPlanningParticipants([], 0)).toEqual([]);
	});
	it('divides fan-out budgets without multiplying reservations', () => {
		expect(planningInstanceTimebox(10, 3)).toBe(3);
		for (const count of [0, 11, NaN]) expect(() => planningInstanceTimebox(10, count)).toThrow();
	});
	it('never exceeds participant caps or the total budget across boundary cases', () => {
		for (let n = 1; n <= 30; n++) for (let budget = n; budget <= n * 5; budget++) {
			const output = boundedPlanningParticipants(participants(n).map((p, i) => ({ ...p, timeboxSeconds: i % 7 + 1 })), budget);
			expect(output.reduce((sum, item) => sum + item.timeboxSeconds, 0)).toBeLessThanOrEqual(budget);
			expect(output.every((item, i) => item.timeboxSeconds >= 1 && item.timeboxSeconds <= i % 7 + 1)).toBe(true);
		}
	});
	it('persists the same bounded budgets used by preflight and wave compilation', async () => {
		const agents = participants(3).map(p => ({ ...p, slug: p.nodeId, projectAgentClassId: 'class', activityType: 'plan', execution: { timeboxSeconds: 900 } }));
		const graph = { nodes: agents.map(p => ({ id: p.nodeId, stage: 'discovery' })), edges: [], externalRoots: [], diagnostics: [], ok: true };
		const snapshots = new Map([['project', { revision: 'exact', graph, agents }]]) as Parameters<typeof compileCooperativePlanningSession>[0]['snapshots'];
		const input = { snapshots, rounds: 3, maxConcurrentAssignments: 2, allocatedSeconds: 24, assignmentTimeboxSeconds: 900 };
		const result = compileCooperativePlanningSession(input);
		expect(result.compiled.requiredSeconds).toBe(24);
		expect(result.participants.map(p => p.timeboxSeconds)).toEqual([8, 8, 8]);
		const batches: unknown[][] = [];
		const database = { batch: async (operations: unknown[]) => { batches.push(operations); } } as Parameters<typeof initializeCooperativePlanningSession>[0]['database'];
		await initializeCooperativePlanningSession({ ...input, database, teamId: 'team', runId: 'run', sessionId: 'session', now: '2026-09-11T00:00:00Z' });
		const stored = batches.flat() as Array<{ query: string; params: unknown[] }>;
		expect(stored.filter(row => row.query.includes('INSERT INTO workday_planning_participants')).map(row => JSON.parse(String(row.params[5])).timeboxSeconds)).toEqual([8, 8, 8]);
	});
});
