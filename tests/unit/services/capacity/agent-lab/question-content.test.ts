import { describe,expect,it } from 'vitest';
import { parseValidatedQuestionContent } from '../../../../../src/api/capacity/routes/support/agent-lab/question-content.ts';

describe('Agent Lab question content validation', () => {
	it('returns exact Zod field diagnostics for chat and operator feedback', () => {
		const result = parseValidatedQuestionContent('src/content/questions/missing-title.mdx','---\nquestionType: knowledge-gap\n---\nWhat is missing?');

		expect(result.ok).toBe(false);
		expect(result.diagnostics).toContainEqual(expect.objectContaining({
			path: 'src/content/questions/missing-title.mdx',
			field: 'title',
			code: 'content_zod_invalid_type',
		}));
	});

	it('normalizes aliases before accepting a valid question', () => {
		const result = parseValidatedQuestionContent('src/content/questions/architecture.mdx','---\ntitle: How should this work?\nquestionType: knowledge-gap\n---\nDescribe the architecture.');

		expect(result.ok).toBe(true);
		expect(result.frontmatter).toMatchObject({ title: 'How should this work?',questionType: 'knowledge-gap' });
	});
});
