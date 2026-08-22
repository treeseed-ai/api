import { validateContentRecord } from '../../../../content/content-validation.ts';

export interface QuestionContentDiagnostic {
	path: string;
	field?: string;
	code: string;
	message: string;
}

export function parseValidatedQuestionContent(path: string, source: string) {
	try {
		const result = validateContentRecord('question', source);
		const diagnostics: QuestionContentDiagnostic[] = result.diagnostics.map((diagnostic) => ({
			path,
			...(diagnostic.field ? { field: diagnostic.field } : {}),
			code: diagnostic.code,
			message: diagnostic.message,
		}));
		return result.ok
			? { ok: true as const, frontmatter: result.frontmatter, body: result.body, diagnostics: [] }
			: { ok: false as const, frontmatter: result.frontmatter, body: result.body, diagnostics };
	} catch (error) {
		return {
			ok: false as const,
			frontmatter: {},
			body: '',
			diagnostics: [{
				path,
				code: 'content_frontmatter_invalid',
				message: error instanceof Error ? error.message : 'Question frontmatter could not be parsed.',
			}],
		};
	}
}
