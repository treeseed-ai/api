import { beforeEach, expect, it, vi } from 'vitest';
import { createInboxService } from '../../../../../src/api/control-plane/inbox/inbox-service.ts';
import { loadDiscussions } from '../../../../../src/api/discussions/content.ts';

vi.mock('../../../../../src/api/discussions/content.ts', () => ({ loadDiscussions: vi.fn() }));
const message = { id: 'message', path: 'discussion-messages/topic/message.mdx', immutableRef: 'a'.repeat(40), digest: 'b'.repeat(64),
	frontmatter: { authorId: 'coordinator', createdAt: '2026-10-27T19:00:00.000Z', commitSha: 'f'.repeat(40) }, body: 'Repair the real contribution plan.' };
const history = { ref: 'c'.repeat(40), repositoryId: 'library', discussions: [], messages: [message], events: [], cursor: '' };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(loadDiscussions).mockResolvedValue(structuredClone(history)); });
function fixture() {
	const row = { id: 'proposal', team_id: 'team', project_id: 'project', kind: 'proposal', title: 'Real contribution plan',
		status: 'outstanding', version: 5, discussion_id: 'topic', updated_at: '2026-10-27T19:00:00.000Z' };
	const store = { run: vi.fn(async () => undefined), all: async (sql: string) => sql.includes('FROM inbox_items') ? [row] : [], first: async () => row,
		getProjectDetails: async () => ({ project: { slug: 'project' } }), principalCanAccessTeam: async () => false };
	return { row, store, inbox: createInboxService({ store, discussions: {}, communications: {}, governance: {} }) };
}
it('projects the reader repository, immutable message commit and full document digest instead of authored metadata', async () => {
	const f = fixture(), before = structuredClone(f.row);
	const item = await f.inbox.show({ id: 'coordinator', roles: ['admin'] }, 'team', 'proposal');
	expect(item.comments[0]?.provenance).toEqual({ repositoryId: history.repositoryId, contentPath: message.path,
		commitSha: message.immutableRef, digest: message.digest });
	expect(item.comments[0]?.markdown).toBe(message.body); expect(f.row).toEqual(before);
});
it('keeps absent read provenance unknown without substituting frontmatter or a body hash', async () => {
	const absent = structuredClone(history); absent.repositoryId = ''; absent.messages[0]!.immutableRef = ''; absent.messages[0]!.digest = '';
	vi.mocked(loadDiscussions).mockResolvedValue(absent);
	expect((await fixture().inbox.show({ id: 'coordinator', roles: ['admin'] }, 'team', 'proposal')).comments[0]?.provenance)
		.toEqual({ repositoryId: null, contentPath: message.path, commitSha: null, digest: null });
});
it.each([401, 403, 404, 503])('propagates history read failure %s without claiming an empty discussion', async status => {
	const failure = Object.assign(new Error('Original history read failed.'), { status, code: 'history_unavailable' });
	vi.mocked(loadDiscussions).mockRejectedValueOnce(failure);
	await expect(fixture().inbox.show({ id: 'coordinator', roles: ['admin'] }, 'team', 'proposal')).rejects.toBe(failure);
});
it('denies a foreign principal before reading history', async () => {
	await expect(fixture().inbox.show({ id: 'outsider', roles: [] }, 'team', 'proposal')).rejects.toMatchObject({ status: 403 });
	expect(loadDiscussions).not.toHaveBeenCalled();
});
it('keeps proposal summaries available without fetching discarded comment history', async () => {
	vi.mocked(loadDiscussions).mockRejectedValue(new Error('History is unavailable.'));
	const page = await fixture().inbox.list({ id: 'coordinator', roles: ['admin'] }, 'team', { kind: 'proposal' });
	expect(page.items).toHaveLength(1); expect(page.items[0]?.id).toBe('proposal');
	expect(page.items[0]).not.toHaveProperty('comments'); expect(loadDiscussions).not.toHaveBeenCalled();
});
