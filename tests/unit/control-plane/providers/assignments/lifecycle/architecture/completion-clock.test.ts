import { describe, expect, it } from 'vitest';
import { assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { validateAssignmentResultCompletion } from '../../../../../../../src/api/capacity/services/capacity/assignments/context/assignment-result-completion.ts';
import { recoveryAssignment } from '../../architecture/cancellation-fixture.ts';

describe('canonical completed result original clock authority', () => {
	it('retains a complete arbitrary-class frozen attempt and valid exact result unchanged', () => {
		const assignment = recoveryAssignment(true), workspace = assignment.assignmentAttempt!.workspace;
		if (workspace.mode !== 'git') throw new Error('Expected isolated governed Git workspace');
		const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'result',
			assignmentId: assignment.id, status: 'completed', summary: 'Supplied completed result, not native publication evidence.',
			references: [{ kind: 'git', repository: workspace.repository, branch: workspace.branch, commit: 'b'.repeat(40) }],
			verification: [], usage: { elapsedSeconds: 2 }, diagnostics: [], completedAt: '2026-10-02T21:00:02.000Z' });
		const before = structuredClone({ assignment, result });
		expect(validateAssignmentResultCompletion(assignment, { assignmentResult: result })).toEqual(result);
		expect({ assignment, result }).toEqual(before);
	});
	it('denies before-start and past-original-deadline result timestamps using the same complete frozen authority', () => {
		const assignment = recoveryAssignment(true), workspace = assignment.assignmentAttempt!.workspace;
		if (workspace.mode !== 'git') throw new Error('Expected isolated governed Git workspace');
		const observations: boolean[] = [];
		for (const completedAt of ['2026-10-02T20:59:59.000Z', '2026-10-02T21:00:04.000Z']) {
			const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'result',
				assignmentId: assignment.id, status: 'completed', summary: 'Invalid original clock assertion input.',
				references: [{ kind: 'git', repository: workspace.repository, branch: workspace.branch, commit: 'b'.repeat(40) }],
				verification: [], usage: { elapsedSeconds: 2 }, diagnostics: [], completedAt });
			const before = structuredClone({ assignment, result });
			let denied = false; try { validateAssignmentResultCompletion(assignment, { assignmentResult: result }); } catch { denied = true; }
			observations.push(denied); expect({ assignment, result }).toEqual(before);
		}
		expect(observations).toEqual([true, true]);
	});
});
