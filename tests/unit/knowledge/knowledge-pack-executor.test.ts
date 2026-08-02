import { beforeEach, describe, expect, it, vi } from 'vitest';

const publishedSnapshots = vi.fn();
vi.mock('../../../src/api/knowledge/published-catalog.ts', () => ({
	loadPublishedKnowledgeSnapshots: publishedSnapshots,
}));

const book = {
	schemaVersion: 'treeseed.book/v2', id: 'book.one', slug: 'book-one', title: 'Book one', summary: 'Summary',
	description: 'Description', status: 'published', visibility: 'team', order: 1, topics: [], audience: [],
	relatedBookIds: [], packPolicy: 'allowed',
};
const page = {
	schemaVersion: 'treeseed.knowledge-page/v1', id: 'page.one', bookId: book.id, slug: 'start', title: 'Start',
	summary: 'Start here', status: 'published', visibility: 'team', order: 1, tags: [], contributors: [],
	relatedBookIds: [], relatedKnowledgeIds: [], relatedNoteIds: [], relatedQuestionIds: [], relatedObjectiveIds: [],
	relatedProposalIds: [], relatedDecisionIds: [], guaranteeIds: [], context: { capabilityIds: [], routePatterns: [], resourceTypes: [],
		actionIds: [], keywords: [], documentationUrls: [] }, bodyMarkdown: '# Start', bodyHtml: '', revision: 'one',
};

describe('knowledge-pack operations executor', () => {
	beforeEach(() => publishedSnapshots.mockReset());

	it('stores only private artifact metadata after building an exact TreeDX snapshot', async () => {
		publishedSnapshots.mockResolvedValue([{ teamId: 'team-a', projectId: 'project-a', repositoryId: 'repo-a',
			commitSha: 'abc123', books: [book], pages: [{ definition: page, source: '# Start\n' }] }]);
		const states: any[] = [];
		const stored: any[] = [];
		const store = {
			async getKnowledgePackBuild() { return { id: 'build-a', teamId: 'team-a', requestedByUserId: 'user-a',
				bookIds: ['book.one'], publicationRevision: 'publication-a', status: 'queued', createdAt: '2026-07-31T00:00:00.000Z' }; },
			async updateKnowledgePackBuild(_id: string, input: any) { states.push(input); return { ok: true }; },
			async getTeamAccessSummary() { return { permissions: ['knowledge:build-packs'] }; },
			async recordAuditEvent(event: any) { states.push(event); },
		};
		const privateObjectStorage = {
			async put(kind: string, bytes: Uint8Array, contentType: string) {
				stored.push({ kind, bytes, contentType }); return { key: 'knowledge-packs/private.zip', digest: 'digest-a' };
			},
			async get() { return null; }, async delete() {},
		};
		const knowledgePublicationStorage = { async readRevision() { return { revision: 'publication-a', sourceClosure: 'closure-a' }; } };
		const { createKnowledgePackExecutor } = await import('../../../src/operations-runner/knowledge/pack-executor.ts');
		const result = await createKnowledgePackExecutor({ controlPlaneStore: store, privateObjectStorage, knowledgePublicationStorage })
			.run({ buildId: 'build-a' }, { operation: { id: 'operation-a' }, async checkpoint() {} });
		expect(result).toMatchObject({ ok: true, sourceClosure: expect.any(String), digest: 'digest-a' });
		expect(stored[0]).toMatchObject({ kind: 'knowledge-packs', contentType: 'application/zip' });
		expect(stored[0].bytes).toBeInstanceOf(Uint8Array);
		const completed = states.find((state) => state.status === 'completed');
		expect(completed.artifact).toMatchObject({ storageKey: 'knowledge-packs/private.zip', byteSize: expect.any(Number) });
		expect(completed.artifact).not.toHaveProperty('bytes');
	});

	it('fails closed when the requesting user loses pack permission', async () => {
		const states: any[] = [];
		const store = {
			async getKnowledgePackBuild() { return { id: 'build-a', teamId: 'team-a', requestedByUserId: 'user-a',
				bookIds: ['book.one'], publicationRevision: 'publication-a', status: 'queued', createdAt: '2026-07-31T00:00:00.000Z' }; },
			async updateKnowledgePackBuild(_id: string, input: any) { states.push(input); return { ok: true }; },
			async getTeamAccessSummary() { return { permissions: ['knowledge:read'] }; },
		};
		const { createKnowledgePackExecutor } = await import('../../../src/operations-runner/knowledge/pack-executor.ts');
		await expect(createKnowledgePackExecutor({ controlPlaneStore: store, privateObjectStorage: {} })
			.run({ buildId: 'build-a' }, { operation: { id: 'operation-a' }, async checkpoint() {} }))
			.rejects.toThrow(/no longer has permission/u);
		expect(states.at(-1)).toMatchObject({ status: 'failed' });
	});

	it('expires completed private artifacts and verifies object removal', async () => {
		const updates: any[] = [];
		const events: any[] = [];
		const checkpoints: any[] = [];
		let present = true;
		const store = {
			async listKnowledgePackBuilds() { return [{ id: 'build-expired', teamId: 'team-a', status: 'completed',
				publicationRevision: 'publication-a', artifact: { storageKey: 'knowledge-packs/expired.zip', expiresAt: '2026-07-30T00:00:00.000Z' } }]; },
			async updateKnowledgePackBuild(_id: string, input: any) { updates.push(input); return { ok: true }; },
			async recordAuditEvent(event: any) { events.push(event); },
		};
		const privateObjectStorage = {
			async delete(key: string) { expect(key).toBe('knowledge-packs/expired.zip'); present = false; },
			async get() { return present ? new Uint8Array([1]) : null; },
		};
		const { createKnowledgePackCleanupExecutor } = await import('../../../src/operations-runner/knowledge/pack-executor.ts');
		const result = await createKnowledgePackCleanupExecutor({ controlPlaneStore: store, privateObjectStorage })
			.run({ teamId: 'team-a', now: '2026-07-31T00:00:00.000Z' }, { async checkpoint(value: any) { checkpoints.push(value); } });
		expect(result).toEqual({ ok: true, teamId: 'team-a', expired: 1 });
		expect(updates).toContainEqual({ expectedStatus: 'completed', status: 'expired', artifact: {} });
		expect(events[0]).toMatchObject({ eventType: 'knowledge.pack.expired', targetId: 'build-expired' });
		expect(checkpoints[0]).toMatchObject({ phase: 'knowledge.pack.cleanup', expired: 1 });
	});
});
