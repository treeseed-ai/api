import { describe, expect, it } from 'vitest';
import { requireKnowledgePageBookPath } from '../../../../src/api/knowledge/snapshot-projects.ts';

describe('knowledge page library layout', () => {
	it('accepts pages nested under their declared book', () => {
		expect(() => requireKnowledgePageBookPath('knowledge/platform/overview.mdx', 'knowledge/', {
			bookId: 'platform', slug: 'overview',
		})).not.toThrow();
	});

	it('rejects flat or mismatched knowledge entries', () => {
		expect(() => requireKnowledgePageBookPath('knowledge/overview.mdx', 'knowledge/', {
			bookId: 'platform', slug: 'overview',
		})).toThrow(/must be stored under knowledge\/platform\//u);
	});
});
