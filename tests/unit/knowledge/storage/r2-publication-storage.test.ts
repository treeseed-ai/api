import { describe, expect, it, vi } from 'vitest';
import { buildKnowledgePublication } from '../../../../src/api/knowledge/build-publication.ts';
import { createR2KnowledgePublicationStorage } from '../../../../src/api/knowledge/r2-publication-storage.ts';

function snapshot(commitSha = 'a'.repeat(40)) {
	return [{ teamId: 'team-a', projectId: 'project-a', repositoryId: 'repo-a', commitSha,
		books: [{ schemaVersion: 'treeseed.book/v2', id: 'book.safe', slug: 'safe', title: 'Safe book',
			summary: 'Safe guidance.', description: 'Safe guidance.', status: 'published', visibility: 'public',
			order: 1, topics: [], audience: [], relatedBookIds: [], packPolicy: 'allowed' }],
		pages: [{ source: 'Safe.', definition: { schemaVersion: 'treeseed.knowledge-page/v1', id: 'knowledge.safe',
			bookId: 'book.safe', slug: 'start', title: 'Start', summary: 'Start safely.', status: 'published',
			visibility: 'public', order: 1, tags: [], contributors: [], relatedBookIds: [], relatedKnowledgeIds: [],
			relatedNoteIds: [], relatedQuestionIds: [], relatedObjectiveIds: [], relatedProposalIds: [], relatedDecisionIds: [],
			guaranteeIds: [], context: { capabilityIds: [], routePatterns: [], resourceTypes: [], actionIds: [], keywords: [],
				documentationUrls: [] }, bodyMarkdown: 'Safe.', bodyHtml: '<p>Safe.</p>', revision: 'page-a' } }] }] as any;
}

function fakeR2(pageSize = Number.POSITIVE_INFINITY) {
	const objects = new Map<string, { body: string; etag: string }>();
	let etag = 0;
	const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const path = url.pathname.split('/').slice(2).map(decodeURIComponent).join('/');
		const headers = new Headers(init?.headers);
		if (url.searchParams.get('list-type') === '2') {
			const prefix = url.searchParams.get('prefix') ?? '';
			const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
			const offset = Number(url.searchParams.get('continuation-token') ?? 0);
			const page = keys.slice(offset, offset + pageSize); const next = offset + page.length;
			return new Response(`<ListBucketResult>${page.map((key) => `<Contents><Key>${key}</Key></Contents>`).join('')}`
				+ `<IsTruncated>${next < keys.length}</IsTruncated>${next < keys.length ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}</ListBucketResult>`);
		}
		if (init?.method === 'GET') {
			const value = objects.get(path);
			return value ? new Response(value.body, { headers: { etag: value.etag } }) : new Response('', { status: 404 });
		}
		if (init?.method === 'PUT') {
			const current = objects.get(path);
			if (headers.get('if-none-match') === '*' && current) return new Response('', { status: 412 });
			if (headers.has('if-match') && headers.get('if-match') !== current?.etag) return new Response('', { status: 412 });
			objects.set(path, { body: String(init.body ?? ''), etag: `"etag-${++etag}"` });
			return new Response('', { status: 200 });
		}
		if (init?.method === 'DELETE') { objects.delete(path); return new Response('', { status: 204 }); }
		return new Response('', { status: 405 });
	});
	return { objects, fetchImpl };
}

const env = {
	TREESEED_CLOUDFLARE_ACCOUNT_ID: 'account-a', TREESEED_R2_ACCESS_KEY_ID: 'access-a',
	TREESEED_R2_SECRET_ACCESS_KEY: 'secret-value-never-persisted', TREESEED_CONTENT_BUCKET_NAME: 'publication-bucket',
	TREESEED_KNOWLEDGE_PUBLICATION_PREFIX: 'acceptance/run-a',
};

describe('R2 knowledge publication storage', () => {
	it('writes immutable objects and advances the current pointer with an exact ETag lease', async () => {
		const remote = fakeR2();
		const storage = createR2KnowledgePublicationStorage({ env, fetchImpl: remote.fetchImpl as typeof fetch });
		const first = buildKnowledgePublication({ teamId: 'team-a', generatedAt: '2026-08-01T00:00:00.000Z',
			projects: snapshot(), graphRevisions: { 'project-a': 'graph-a' }, refs: { 'project-a': 'main' } });
		await storage.publish({ manifest: first.manifest, objects: first.objects });
		expect(await storage.readCurrent('team-a')).toMatchObject({ revision: first.manifest.revision });
		const second = buildKnowledgePublication({ teamId: 'team-a', generatedAt: '2026-08-01T00:01:00.000Z',
			previousRevision: first.manifest.revision, projects: snapshot('b'.repeat(40)),
			graphRevisions: { 'project-a': 'graph-b' }, refs: { 'project-a': 'main' } });
		await storage.publish({ manifest: second.manifest, objects: second.objects, expectedRevision: first.manifest.revision });
		expect(await storage.readCurrent('team-a')).toMatchObject({ revision: second.manifest.revision,
			previousRevision: first.manifest.revision });
		const requests = remote.fetchImpl.mock.calls.map((call) => JSON.stringify(call));
		expect(requests.some((request) => request.includes('if-match'))).toBe(true);
		expect(requests.join('\n')).not.toContain(env.TREESEED_R2_SECRET_ACCESS_KEY);
	});

	it('leaves the current manifest unchanged after a stale publication attempt', async () => {
		const remote = fakeR2();
		const storage = createR2KnowledgePublicationStorage({ env, fetchImpl: remote.fetchImpl as typeof fetch });
		const built = buildKnowledgePublication({ teamId: 'team-a', generatedAt: '2026-08-01T00:00:00.000Z',
			projects: snapshot(), graphRevisions: { 'project-a': 'graph-a' }, refs: { 'project-a': 'main' } });
		await storage.publish({ manifest: built.manifest, objects: built.objects });
		await expect(storage.publish({ manifest: { ...built.manifest, revision: 'other-revision' }, objects: [],
			expectedRevision: 'stale-revision' })).rejects.toThrow(/revision changed/u);
		expect((await storage.readCurrent('team-a'))?.revision).toBe(built.manifest.revision);
	});

	it('lists every immutable revision across bounded R2 continuation pages', async () => {
		const remote = fakeR2(1);
		const storage = createR2KnowledgePublicationStorage({ env, fetchImpl: remote.fetchImpl as typeof fetch });
		const first = buildKnowledgePublication({ teamId: 'team-a', generatedAt: '2026-08-01T00:00:00.000Z',
			projects: snapshot(), graphRevisions: { 'project-a': 'graph-a' }, refs: { 'project-a': 'main' } });
		const second = buildKnowledgePublication({ teamId: 'team-a', generatedAt: '2026-08-01T00:01:00.000Z',
			previousRevision: first.manifest.revision, projects: snapshot('b'.repeat(40)),
			graphRevisions: { 'project-a': 'graph-b' }, refs: { 'project-a': 'main' } });
		await storage.publish({ manifest: first.manifest, objects: first.objects });
		await storage.publish({ manifest: second.manifest, objects: second.objects, expectedRevision: first.manifest.revision });
		const revisions = await storage.listRevisions!('team-a');
		expect(revisions.map((item) => item.revision).sort()).toEqual([first.manifest.revision, second.manifest.revision].sort());
		expect(remote.fetchImpl.mock.calls.some(([url]) => String(url).includes('continuation-token'))).toBe(true);
	});
});
