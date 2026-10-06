import { describe, expect, it } from 'vitest';
import { selectTreeDxReadRepositoryGrant, treeDxRequestedReadRef } from '../../../../../src/api/control-plane/repositories/treedx/proxy-operation-service.ts';

describe('assignment TreeDX secondary repository grant selection', () => {
	it('selects the exact commit grant when one project library contributes multiple contexts', () => {
		const objective = 'a'.repeat(40), readme = 'b'.repeat(40);
		const grants = [
			{ projectId: 'sdk', repositoryId: 'sdk-library', baseRef: objective, allowedPaths: ['objectives/core'] },
			{ projectId: 'sdk', repositoryId: 'sdk-library', baseRef: readme, allowedPaths: ['README.md'] },
		];
		expect(selectTreeDxReadRepositoryGrant(grants, 'sdk', 'sdk-library', readme))
			.toEqual(grants[1]);
		expect(selectTreeDxReadRepositoryGrant(grants, 'sdk', 'sdk-library', 'c'.repeat(40)))
			.toBeUndefined();
	});

	it('uses the body ref for batch reads so same-repository grants remain commit-scoped', () => {
		const objective = 'a'.repeat(40), readme = 'b'.repeat(40);
		expect(treeDxRequestedReadRef('POST', {}, { ref: readme })).toBe(readme);
		expect(treeDxRequestedReadRef('GET', { ref: objective }, {})).toBe(objective);
	});
});
