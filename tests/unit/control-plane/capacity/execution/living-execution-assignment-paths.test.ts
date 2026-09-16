import { describe, expect, it } from 'vitest';
import { treeDxAuthorizedPaths } from '../../../../../src/api/capacity/services/capacity/assignments/planning/execution/living-execution-assignment.ts';

describe('living execution TreeDX path authority', () => {
	it('authorizes the resolved file for an extensionless logical path without widening its basename', () => {
		expect(treeDxAuthorizedPaths(['objectives/core', 'README.md', 'discussion-messages/**'])).toEqual([
			'objectives/core', 'objectives/core.md', 'objectives/core.mdx', 'objectives/core.yaml',
			'objectives/core.yml', 'objectives/core.json', 'README.md', 'discussion-messages/**',
		]);
	});
});
