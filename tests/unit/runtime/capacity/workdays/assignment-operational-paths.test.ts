import { describe,expect,it } from 'vitest';
import { assignmentBootstrapReadPaths,assignmentContextQueryReadPaths,assignmentInstructionTemplateReadPaths,assignmentOperationalContentPaths,mergeAssignmentPathScopes } from '../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-operational-paths.ts';

describe('assignment operational content paths', () => {
	it('adds only assignment-scoped plan, status, and summary custody', () => {
		expect(assignmentOperationalContentPaths('src/content/', 'assignment-1')).toEqual([
		'src/content/assignment-plans/assignment-1.mdx',
			'src/content/assignment-statuses/assignment-1-status-*',
		'src/content/assignment-summaries/assignment-1.mdx',
	]);
	});

	it('unions operational custody with task scopes without duplication', () => {
		expect(mergeAssignmentPathScopes(['src/content/objectives/**'], ['src/content/assignment-plans/a.mdx'], ['src/content/objectives/**'])).toEqual([
		'src/content/objectives/**',
		'src/content/assignment-plans/a.mdx',
	]);
	});

	it('grants exact immutable bootstrap reads without adding patterns', () => {
		expect(assignmentBootstrapReadPaths('src/content', 'src/content/agents/editor.mdx', 'src/content/objectives/guide.mdx')).toEqual([
			'src/content/agents/editor.mdx',
			'src/content/objectives/guide.mdx',
		]);
		expect(assignmentBootstrapReadPaths('src/content', undefined, '')).toEqual([]);
	});

	it('freezes exact legacy editorial anchors as read-only bootstrap dependencies', () => {
		expect(assignmentBootstrapReadPaths('src/content', 'src/content/agents/editorial/writer.mdx', undefined)).toEqual([
		'src/content/agents/editorial/writer.mdx',
		'src/content/objectives/core.mdx',
		'src/content/objectives/core.md',
		'src/content/notes/editorial/core.mdx',
		'src/content/notes/editorial/core.md',
		'src/content/notes/editorial/books/treeseed-guide/core.mdx',
		'src/content/notes/editorial/books/treeseed-guide/core.md',
	]);
	});

	it('grants only frozen query definitions and paths proven by the admitted live check', () => {
		expect(assignmentContextQueryReadPaths('src/content', [
			{ kind: 'query-set', id: 'guide-work-foundation', revision: 2 },
			{ kind: 'query', id: 'guide-work-index', revision: 2 },
		], [{ stats: { paths: ['src/content/knowledge/treeseed-guide/work/agents.md'] } }])).toEqual([
			'src/content/agent-context-query-sets/guide-work-foundation.mdx',
			'src/content/agent-context-queries/**',
			'src/content/agent-context-queries/guide-work-index.mdx',
			'src/content/knowledge/treeseed-guide/work/agents.md',
		]);
	});

	it('grants exact instruction-template documents as read-only assignment context', () => {
		expect(assignmentInstructionTemplateReadPaths('src/content', [
			{ id:'assignment-plan-standard',revision:1 },{ id:'assignment-summary-standard',revision:1 },{ id:'',revision:1 },
		])).toEqual([
			'src/content/agent-instruction-templates/assignment-plan-standard.mdx',
			'src/content/agent-instruction-templates/assignment-plan-standard.md',
			'src/content/agent-instruction-templates/assignment-summary-standard.mdx',
			'src/content/agent-instruction-templates/assignment-summary-standard.md',
		]);
	});
});
