import { describe, expect, it } from 'vitest';
import { resolveAssignmentContentPathScope } from '../../../../src/api/capacity/services/capacity/assignments/planning/assignment-content-path-scope.ts';
import { assignmentDiscussionMessageReadPaths, assignmentOperationalContentPaths } from '../../../../src/api/capacity/services/capacity/assignments/planning/assignment-operational-paths.ts';

describe('assignment content path scope', () => {
	it('accepts top-level library collections when the content root is dot', () => {
		expect(resolveAssignmentContentPathScope({
			permissions: { content: { agent: { operations: ['read'] }, knowledge: { operations: ['query'] } } },
		}, 'read', '.', ['**'])).toEqual(['agents/**', 'knowledge/**']);
	});

	it('normalizes fallback and operational paths for a top-level library root', () => {
		expect(resolveAssignmentContentPathScope({}, 'write', '.', [
			'./discussion-messages', './discussion-messages/**',
		])).toEqual(['discussion-messages', 'discussion-messages/**']);
		expect(assignmentOperationalContentPaths('.', 'assignment_1')).toEqual([
			'assignment-plans/assignment_1.mdx',
			'assignment-statuses/assignment_1-status-*',
			'assignment-summaries/assignment_1.mdx',
		]);
	});

	it('scopes conversation source reads to root or nested discussion messages', () => {
		expect(assignmentDiscussionMessageReadPaths([
			'message-id',
			'discussion-messages/topic/message.mdx',
			'./discussion-messages/topic/second.mdx',
			'src/content/discussion-messages/topic/legacy.mdx',
			'knowledge/private.mdx',
		])).toEqual([
			'discussion-messages/topic/message.mdx',
			'discussion-messages/topic/second.mdx',
			'src/content/discussion-messages/topic/legacy.mdx',
		]);
	});
});
