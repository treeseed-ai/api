import { describe, expect, it } from 'vitest';
import { assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { buildAssignmentAttempt } from '../../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { canonicalOfferBuildInput } from '../../fixtures/assignment-attempt-fixtures.ts';

// Controlled exact dependency inputs. These are not model products, reviews,
// repository custody, settlement, or native workday execution evidence.
function sourceIntegrationInput() {
	const input = canonicalOfferBuildInput();
	input.candidate.node.workItemId = 'combine-reviewed-source';
	input.candidate.predecessorResults = ['8', '9'].map(digit => assignmentResultSchema.parse({
		schemaVersion: 'treeseed.assignment-result/v1', id: `source-result-${digit}`, assignmentId: `source-attempt-${digit}`,
		status: 'completed', summary: 'Supplied retained source input.',
		references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: digit.repeat(40) }],
		verification: [], usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: input.now,
	}));
	input.candidate.contextRefs.push(...['8', '9'].map(digit => ({ store: 'git' as const, model: 'repository',
		id: `source-${digit}`, repository: 'treeseed-ai/sdk', commit: digit.repeat(40) })));
	return input;
}

describe('ordinary Git source integration authority', () => {
	it('combines exact retained Git predecessors under source-write authority without granting publication or selecting an identity', () => {
		for (const identity of ['configured-composition-author', 'customer-source-worker']) {
			const input = sourceIntegrationInput();
			input.candidate.node.agentClass = identity;
			input.candidate.effectiveProfile.profileRef.id = `configured/${identity}`;
			const before = structuredClone(input), result = buildAssignmentAttempt(input);
			expect(result.assignment.workspace).toMatchObject({ mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: 'c'.repeat(40) });
			expect(result.assignment.predecessorResultIds).toEqual(['source-result-8', 'source-result-9']);
			expect(result.assignment.contextRefs).toEqual(expect.arrayContaining(input.candidate.contextRefs));
			expect(result.assignment.grant.sourceWrite).toEqual(['treeseed-ai/sdk']);
			expect(result.assignment.grant.tools).toEqual(['source.read', 'source.write', 'verification']);
			expect(result.assignment.grant.tools).not.toContain('release');
			expect(result.assignment.effectiveProfile).toEqual(input.candidate.effectiveProfile);
			expect(result.assignment.deadline).toBe(input.run.parameters.appliedPlan.endsAt);
			for (const replay of [structuredClone(input), structuredClone(input)]) expect(buildAssignmentAttempt(replay)).toEqual(result);
			expect(input).toEqual(before);
		}
	});
});
