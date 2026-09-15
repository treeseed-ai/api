import { describe, expect, it } from 'vitest';
import { constrainAssignmentContentPathScope, resolveAssignmentContentPathScope } from '../../../../src/api/capacity/services/capacity/assignments/planning/assignment-content-path-scope.ts';

describe('assignment content output boundaries', () => {
	it('maps canonical execution-plan authority to its TreeDX collection', () => {
		const payload = { permissions: { content: { execution_plan: { operations: ['create', 'validate', 'commit'] } } } };
		expect(resolveAssignmentContentPathScope(payload, 'write', '.', [])).toEqual(['execution-plans/**']);
	});

	it('narrows broad model grants to compiler-declared output paths', () => {
		expect(constrainAssignmentContentPathScope(['notes/**', 'proposals/**'], ['notes/**'])).toEqual(['notes/**']);
	});

	it('rejects a declared output outside the agent grant', () => {
		expect(() => constrainAssignmentContentPathScope(['notes/**'], ['decisions/**'])).toThrow('exceed the agent content grant');
	});
});
