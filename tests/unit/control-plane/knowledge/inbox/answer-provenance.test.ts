import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { serializeFrontmatterDocument } from '../../../../../src/api/content/frontmatter.ts';
import { readInboxQuestionAnswer } from '../../../../../src/api/control-plane/inbox/question-content.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', async original => ({
	...await original<object>(), resolveKnowledgeGatewayConnection: vi.fn(),
}));
const input = { store: { getProjectTreeDxLibrary: async () => ({ contentPath: '.' }) }, projectId: 'project',
	discussionId: 'handoff', path: 'discussion-messages/handoff/answer.mdx', commit: 'a'.repeat(40), authorId: 'coordinator' };
const metadata = { schemaVersion: 'treeseed.discussion-message/v1', id: 'answer', discussionId: 'handoff', inboxIntent: 'answer', authorId: 'coordinator' };
let source: string, resolvedRef: string, path: string;
beforeEach(() => {
	vi.clearAllMocks(); source = serializeFrontmatterDocument(metadata, 'Reviewed transport adopted.'); resolvedRef = input.commit; path = input.path;
	vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ repositoryId: 'library',
		client: { readRepositoryFiles: async () => ({ resolvedRef, files: [{ path, content: source }] }) },
	} as unknown as NonNullable<Awaited<ReturnType<typeof resolveKnowledgeGatewayConnection>>>);
});
it('uses full immutable answer bytes and canonical exact-reference fields', async () => {
	expect(await readInboxQuestionAnswer(input)).toEqual({ store: 'treedx', model: 'discussion-message', id: 'answer', revision: 1,
		digest: `sha256:${createHash('sha256').update(source).digest('hex')}`, repository: 'library', path, commit: input.commit });
	expect(vi.mocked(resolveKnowledgeGatewayConnection).mock.calls[0]?.[1]).toEqual({ projectId: 'project', write: false,
		readRefs: [input.commit], workspacePaths: [input.path] });
});
it.each([{ inboxIntent: 'comment' }, { discussionId: 'other' }, { authorId: 'other' }, { schemaVersion: 'other' }])('refuses non-answer or mismatched message authority: %j', patch => {
	source = serializeFrontmatterDocument({ ...metadata, ...patch }, 'Reviewed transport adopted.');
	return expect(readInboxQuestionAnswer(input)).rejects.toMatchObject({ code: 'inbox_answer_readback_failed' });
});
it.each(['moved', 'wrong-path', 'empty'] as const)('refuses %s readback', fault => {
	if (fault === 'moved') resolvedRef = 'b'.repeat(40);
	if (fault === 'wrong-path') path = 'discussion-messages/handoff/other.mdx';
	if (fault === 'empty') source = serializeFrontmatterDocument(metadata, '');
	return expect(readInboxQuestionAnswer(input)).rejects.toMatchObject({ code: 'inbox_answer_readback_failed' });
});
it.each([{ commit: 'refs/heads/staging' }, { path: 'notes/answer.mdx' }, { path: 'discussion-messages/other/answer.mdx' }])('denies invalid authority before acquiring a scoped reader: %j', patch => {
	return expect(readInboxQuestionAnswer({ ...input, ...patch })).rejects.toMatchObject({ code: 'inbox_answer_readback_failed' })
		.then(() => expect(resolveKnowledgeGatewayConnection).not.toHaveBeenCalled());
});
