import { describe, expect, it } from 'vitest';
import { assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { validateAssignmentResultCompletion } from '../../../../../../../src/api/capacity/services/capacity/assignments/context/assignment-result-completion.ts';
import { recoveryAssignment } from '../../architecture/cancellation-fixture.ts';

describe('canonical completed result original clock authority', () => {
	it('denies failed and blocked canonical results on the successful completion boundary without changing supplied authority', () => {
		const assignment = recoveryAssignment(true), workspace = assignment.assignmentAttempt!.workspace;
		if (workspace.mode !== 'git') throw new Error('Expected original Git workspace');
		for (const status of ['failed', 'blocked'] as const) {
			const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'original-noncompleted-result',
				assignmentId: assignment.id, status, summary: 'Original non-completed observation.',
				references: [{ kind: 'git', repository: workspace.repository, branch: workspace.branch, commit: 'b'.repeat(40) }],
				verification: [], usage: { elapsedSeconds: 2 }, diagnostics: [], completedAt: '2026-10-02T21:00:02.000Z' });
			const held = structuredClone({ assignment, result });
			// The original public completion contract already owns this denial code.
			// Both transport forms must retain it, not invent a second status error.
			for (const input of [{ assignmentResult: result }, { output: { assignmentResult: result } }]) {
				const original = structuredClone(input);
				expect(() => validateAssignmentResultCompletion(assignment, input)).toThrowError(expect.objectContaining({ code: 'assignment_content_result_invalid' }));
				expect(input).toEqual(original);
			}
			expect({ assignment, result }).toEqual(held);
		}
	});
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
		for (const field of ['id', 'assignmentId'] as const) for (const nested of [false, true]) {
			const changed = { ...result, [field]: ` ${result[field]} ` }, input = nested
				? { output: { assignmentResult: changed } } : { assignmentResult: changed };
			const original = structuredClone({ assignment, input });
			expect(() => validateAssignmentResultCompletion(assignment, input)).toThrowError(expect.objectContaining({ code: 'assignment_result_invalid' }));
			expect({ assignment, input }).toEqual(original);
		}
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
