import { describe, expect, it } from 'vitest';
import { reservationFairUsage, treeDxAuthorizedPaths, workdayConcurrencyAvailable } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/living-execution-assignment.ts';

describe('living execution TreeDX path authority', () => {
	it('keeps communication admission independent of the ordinary workday slot', () => {
		const policy = { maximumConcurrency: 1, communicationConcurrency: 2 };
		expect(workdayConcurrencyAvailable('acting', { workday: 1, conversation: 0 }, policy)).toBe(false);
		expect(workdayConcurrencyAvailable('communication', { workday: 1, conversation: 1 }, policy)).toBe(true);
		expect(workdayConcurrencyAvailable('communication', { workday: 0, conversation: 2 }, policy)).toBe(false);
		expect(workdayConcurrencyAvailable('reviewing', { workday: 0, conversation: 2 }, policy)).toBe(true);
	});
	it('counts active reservations once and releases unused terminal capacity for fairness', () => {
		const rows = ['reserved', 'consuming', 'consumed', 'released'].map((state) => ({
			project_id: 'sdk', agent_class: 'engineer', state, reserved_seconds: 180, active_seconds: 30, elapsed_seconds: 900 }));
		expect(reservationFairUsage(rows).map((entry) => entry.seconds)).toEqual([180, 180, 30, 30]);
		expect(reservationFairUsage(rows)[0]).toMatchObject({ projectId: 'sdk', agentClass: 'engineer' });
	});
	it('authorizes the resolved file for an extensionless logical path without widening its basename', () => {
		expect(treeDxAuthorizedPaths(['objectives/core', 'README.md', 'discussion-messages/**'])).toEqual([
			'objectives/core', 'objectives/core.md', 'objectives/core.mdx', 'objectives/core.yaml',
			'objectives/core.yml', 'objectives/core.json', 'README.md', 'discussion-messages/**',
		]);
	});
});
