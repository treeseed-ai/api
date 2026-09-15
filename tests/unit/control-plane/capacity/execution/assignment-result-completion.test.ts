import { describe, expect, it } from 'vitest';
import { validateAssignmentResultCompletion } from '../../../../../src/api/capacity/services/capacity/assignments/context/assignment-result-completion.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const assignment = {
	id: 'assignment-1', teamId: 'team-1', projectId: 'project-1', executionNodeId: 'node-1', executionNodeRevision: 1,
	assignmentAttempt: { id: 'assignment-1', workspace: { mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: 'c'.repeat(40), branch: 'treeseed/assignments/assignment-1', writablePaths: ['src'] } },
};
const result = {
	schemaVersion: 'treeseed.assignment-result/v1', id: 'result-1', assignmentId: 'assignment-1',
	status: 'completed', summary: 'Completed.', references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: 'b'.repeat(40), branch: 'treeseed/assignments/assignment-1' }],
	verification: [{ command: 'npm test', status: 'passed', exitCode: 0, outputDigest: digest }],
	usage: { elapsedSeconds: 3 }, diagnostics: [], completedAt: '2026-09-13T12:00:00.000Z',
};

describe('canonical assignment result completion', () => {
	it('accepts the one general AgentKernel result contract', () => {
		expect(validateAssignmentResultCompletion(assignment as never, { output: { assignmentResult: result } })).toEqual(result);
	});

	it('rejects missing, malformed, and cross-assignment results', () => {
		expect(() => validateAssignmentResultCompletion(assignment as never, { output: {} })).toThrow('canonical assignment result');
		expect(() => validateAssignmentResultCompletion(assignment as never, { output: { assignmentResult: { ...result, assignmentId: 'other' } } })).toThrow('does not belong');
	});

	it('rejects mutable output outside the exact assignment branch', () => {
		expect(() => validateAssignmentResultCompletion(assignment as never, { output: { assignmentResult: {
			...result, references: [{ ...result.references[0], branch: 'staging' }],
		} } })).toThrow('exact committed workspace reference');
	});
});
