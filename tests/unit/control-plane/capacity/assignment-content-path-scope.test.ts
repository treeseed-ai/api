import { describe, expect, it } from 'vitest';
import { resolveAssignmentContentPathScope } from '../../../../src/api/capacity/services/capacity/assignments/planning/assignment-content-path-scope.ts';

describe('assignment content path scope', () => {
	it('accepts top-level library collections when the content root is dot', () => {
		expect(resolveAssignmentContentPathScope({
			permissions: { content: { agent: { operations: ['read'] }, knowledge: { operations: ['query'] } } },
		}, 'read', '.', ['**'])).toEqual(['agents/**', 'knowledge/**']);
	});
});
