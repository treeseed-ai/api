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
	it('accepts exact TreeDX discussion output under a recursive workspace grant', () => {
		const workspace = { mode: 'treedx', repository: 'repo-sdk', workspaceId: 'workspace-1', baseCommit: 'c'.repeat(40), writablePaths: ['discussion-messages/**', 'discussion-events/**'] };
		const scoped = { ...assignment, assignmentAttempt: { ...assignment.assignmentAttempt, workspace } };
		const reference = { kind: 'treedx', projectId: 'project-1', repository: 'repo-sdk', workspaceId: 'workspace-1', commit: 'b'.repeat(40), path: 'discussion-messages/topic/response.mdx' };
		const output = { ...result, references: [reference] };
		expect(validateAssignmentResultCompletion(scoped as never, { assignmentResult: output })).toEqual(output);
		for (const invalid of [{ ...reference, repository: 'other' }, { ...reference, workspaceId: 'other' },
			{ ...reference, path: 'knowledge/response.mdx' }, { ...reference, path: 'discussion-messages/../knowledge/response.mdx' }]) {
			expect(() => validateAssignmentResultCompletion(scoped as never, { assignmentResult: { ...output, references: [invalid] } })).toThrow();
		}
	});
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
