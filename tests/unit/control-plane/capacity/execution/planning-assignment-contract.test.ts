import { describe, expect, it } from 'vitest';
import { compilePlanningAllowedOutputs, compilePlanningAssignmentInput } from '../../../../../src/api/capacity/services/capacity/assignments/planning/planning-assignment-contract.ts';

describe('planning assignment contract', () => {
	it('preserves explicit planning intent and artifact kinds for the provider', () => {
		const intent = { artifactKind: 'proposal_feedback_note', subjectModel: 'proposal', subjectId: 'proposal-1' };
		expect(compilePlanningAssignmentInput({ repositoryId: 'repo' }, intent, 'planning')).toMatchObject({ intent, ...intent });
		expect(compilePlanningAllowedOutputs({ allowedOutputs: { artifactKinds: ['proposal_feedback_note'] } }, intent, 'planning', ['notes/**']))
			.toMatchObject({ paths: ['notes/**'], types: ['content_artifact_refs', 'proposal_feedback_note'], artifactKinds: ['proposal_feedback_note'] });
	});
});
