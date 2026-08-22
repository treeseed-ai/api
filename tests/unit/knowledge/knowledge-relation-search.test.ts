import { describe, expect, it, vi } from 'vitest';
import { reviewPathsMatch, searchRelations } from '../../../src/api/knowledge/relation-search.ts';
import { RelationContentValidationError } from '../../../src/api/knowledge/relation-search.ts';

describe('knowledge relationship search', () => {
	it('maps authorized TreeDX files to stable functional-content identifiers', async () => {
		const searchRepositoryFiles = vi.fn().mockResolvedValue({ results: [
			{ score: 12, path: 'docs/src/content/notes/traceability.md', snippet: 'Exact source closure.',
				frontmatter: { id: 'note:knowledge-authoring-traceability', title: 'Knowledge authoring traceability' } },
			{ score: 11, path: 'docs/src/content/questions/trustworthy.md', snippet: 'Which postconditions agree?',
				frontmatter: { id: 'question:trustworthy-knowledge-publication', title: 'How should publication stay trustworthy?' } },
		] });
		const connection = { repositoryId: 'repo-admin', baseRef: 'refs/heads/main', contentPath: 'docs/src/content',
			allowedPaths: ['docs/src/content/**'], client: { searchRepositoryFiles } };

		const notes = await searchRelations(connection, 'traceability', new Set(['notes']));
		const questions = await searchRelations(connection, 'trustworthy', new Set(['questions']));

		expect(searchRepositoryFiles).toHaveBeenCalledWith(expect.objectContaining({ repoId: 'repo-admin', ref: 'refs/heads/main' }));
		expect(notes).toEqual([expect.objectContaining({ id: 'note:knowledge-authoring-traceability', kind: 'notes' })]);
		expect(questions).toEqual([expect.objectContaining({ id: 'question:trustworthy-knowledge-publication', kind: 'questions' })]);
	});

	it('rejects malformed indexed content with exact Zod diagnostics', async () => {
		const connection = { repositoryId: 'repo-admin',baseRef: 'refs/heads/main',contentPath: 'docs/src/content',allowedPaths: ['docs/src/content/**'],client: {
			searchRepositoryFiles: vi.fn().mockResolvedValue({ results: [{ path:'docs/src/content/questions/untitled.md',frontmatter:{ questionType:'knowledge-gap' } }] }),
		} };

		await expect(searchRelations(connection,'missing title',new Set(['questions']))).rejects.toMatchObject<RelationContentValidationError>({
			code:'knowledge_relation_content_invalid',status:422,diagnostics:[expect.objectContaining({path:'docs/src/content/questions/untitled.md',model:'question',field:'title',code:'content_zod_invalid_type'})],
		});
	});
});

describe('knowledge review snapshots', () => {
	it('requires a non-empty exact changed-path set before a decision', () => {
		expect(reviewPathsMatch(['b.md', 'a.md'], ['a.md', 'b.md'])).toBe(true);
		expect(reviewPathsMatch([], [])).toBe(false);
		expect(reviewPathsMatch(['a.md'], ['a.md', 'b.md'])).toBe(false);
	});
});
