import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildKnowledgePublication } from '../../../src/api/knowledge/build-publication.ts';
import { createLocalKnowledgePublicationStorage } from '../../../src/api/knowledge/publication-storage.ts';
import { loadPublishedTeamCatalog } from '../../../src/api/knowledge/published-catalog.ts';

const roots: string[] = [];
const previousRoot = process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT;
afterEach(() => {
	if (previousRoot === undefined) delete process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT;
	else process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT = previousRoot;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function snapshot(commitSha = 'a'.repeat(40), projectId = 'project-a') {
	const suffix = projectId === 'project-a' ? '' : `-${projectId.replace(/^project-/u, '')}`;
	return [{ teamId: 'team-a', projectId, repositoryId: `repo${suffix || '-a'}`, commitSha,
		books: [{ schemaVersion: 'treeseed.book/v2', id: `book.safe${suffix}`, slug: `safe${suffix}`, title: 'Safe book',
			summary: 'Safe guidance.', description: 'Safe guidance.', status: 'published', visibility: 'public',
			order: 1, topics: ['safe'], audience: ['operators'], relatedBookIds: [], packPolicy: 'allowed' }],
		pages: [{ source: '---\npage\n---\n', definition: { schemaVersion: 'treeseed.knowledge-page/v1',
			id: `knowledge.safe${suffix}`, bookId: `book.safe${suffix}`, slug: 'start', title: 'Start safely', summary: 'Safe instructions.',
			status: 'published', visibility: 'public', order: 1, tags: [], contributors: [], relatedBookIds: [],
			relatedKnowledgeIds: [], relatedNoteIds: [], relatedQuestionIds: [], relatedObjectiveIds: [],
			relatedProposalIds: [], relatedDecisionIds: [], guaranteeIds: [], context: { capabilityIds: [], routePatterns: [],
				resourceTypes: [], actionIds: [], keywords: [], documentationUrls: [] }, bodyMarkdown: 'Safe.',
			bodyHtml: '<p>Safe.</p>', revision: 'page-revision' } }] }] as any;
}

describe('atomic federated knowledge publication', () => {
	it('publishes immutable objects and advances the current pointer only from the expected revision', async () => {
		const root = mkdtempSync(join(tmpdir(), 'knowledge-publication-'));
		roots.push(root); process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT = root;
		const storage = createLocalKnowledgePublicationStorage();
		const first = buildKnowledgePublication({ teamId: 'team-a', generatedAt: '2026-07-31T00:00:00.000Z',
			projects: snapshot(), graphRevisions: { 'project-a': 'graph-a' }, refs: { 'project-a': 'main' } });
		await storage.publish({ manifest: first.manifest, objects: first.objects });
		expect((await storage.readCurrent('team-a'))?.revision).toBe(first.manifest.revision);
		const loaded = await loadPublishedTeamCatalog({ storage, manifest: first.manifest, teamSlug: 'team-a', projectIds: new Set(['project-a']) });
		expect(loaded.pages.map((page) => page.id)).toEqual(['knowledge.safe']);

		const stale = buildKnowledgePublication({ teamId: 'team-a', generatedAt: '2026-07-31T00:01:00.000Z',
			projects: snapshot('b'.repeat(40)), graphRevisions: { 'project-a': 'graph-b' }, refs: { 'project-a': 'main' } });
		await expect(storage.publish({ manifest: stale.manifest, objects: stale.objects, expectedRevision: 'stale' }))
			.rejects.toThrow(/revision changed/u);
		expect((await storage.readCurrent('team-a'))?.revision).toBe(first.manifest.revision);
	});

	it('rejects a corrupt content-addressed object without replacing the last good manifest', async () => {
		const root = mkdtempSync(join(tmpdir(), 'knowledge-publication-corrupt-'));
		roots.push(root); process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT = root;
		const storage = createLocalKnowledgePublicationStorage();
		const built = buildKnowledgePublication({ teamId: 'team-a', generatedAt: '2026-07-31T00:00:00.000Z',
			projects: snapshot(), graphRevisions: { 'project-a': 'graph-a' }, refs: { 'project-a': 'main' } });
		await storage.publish({ manifest: built.manifest, objects: built.objects });
		writeFileSync(join(root, built.objects[0]!.key), 'corrupt');
		await expect(loadPublishedTeamCatalog({ storage, manifest: built.manifest, teamSlug: 'team-a',
			projectIds: new Set(['project-a']) })).rejects.toThrow(/missing or corrupt/u);
		expect(JSON.parse(readFileSync(join(root, 'teams/team-a/published/common.json'), 'utf8')).revision).toBe(built.manifest.revision);
	});

	it('retires only non-current exact revisions and their unreferenced objects', async () => {
		const root = mkdtempSync(join(tmpdir(), 'knowledge-publication-retirement-'));
		roots.push(root); process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT = root;
		const storage = createLocalKnowledgePublicationStorage();
		const first = buildKnowledgePublication({ teamId: 'team-a', generatedAt: '2026-07-31T00:00:00.000Z',
			projects: snapshot(), graphRevisions: { 'project-a': 'graph-a' }, refs: { 'project-a': 'main' } });
		await storage.publish({ manifest: first.manifest, objects: first.objects });
		const second = buildKnowledgePublication({ teamId: 'team-a', generatedAt: '2026-07-31T00:01:00.000Z',
			projects: snapshot('b'.repeat(40)),
			graphRevisions: { 'project-a': 'graph-b' }, refs: { 'project-a': 'main' } });
		await storage.publish({ manifest: second.manifest, objects: second.objects,
			expectedRevision: first.manifest.revision });
		await expect(storage.retireRevisions!({ teamId: 'team-a', revisions: [second.manifest.revision],
			expectedCurrentRevision: second.manifest.revision })).rejects.toThrow(/current/u);
		const retired = await storage.retireRevisions!({ teamId: 'team-a', revisions: [first.manifest.revision],
			expectedCurrentRevision: second.manifest.revision });
		expect(retired.revisionsRemoved).toEqual([first.manifest.revision]);
		expect(await storage.readRevision('team-a', first.manifest.revision)).toBeNull();
		expect(existsSync(join(root, first.objects[0]!.key))).toBe(false);
		expect(await storage.readCurrent('team-a')).toMatchObject({ revision: second.manifest.revision });
	});

	it('reuses unchanged project entries when building an incremental team publication', () => {
		const first = buildKnowledgePublication({ teamId: 'team-a', generatedAt: '2026-07-31T00:00:00.000Z',
			projects: [...snapshot('a'.repeat(40), 'project-a'), ...snapshot('b'.repeat(40), 'project-b')],
			graphRevisions: { 'project-a': 'graph-a', 'project-b': 'graph-b' },
			refs: { 'project-a': 'main', 'project-b': 'main' } });
		const second = buildKnowledgePublication({ teamId: 'team-a', generatedAt: '2026-07-31T00:01:00.000Z',
			projects: snapshot('c'.repeat(40), 'project-a'), graphRevisions: { 'project-a': 'graph-c' },
			refs: { 'project-a': 'main' }, previousManifest: first.manifest,
			retainedProjectIds: new Set(['project-a', 'project-b']) });
		expect(second.manifest.projects.find((project) => project.projectId === 'project-b'))
			.toEqual(first.manifest.projects.find((project) => project.projectId === 'project-b'));
		expect(second.manifest.entries.filter((entry) => entry.projectId === 'project-b'))
			.toEqual(first.manifest.entries.filter((entry) => entry.projectId === 'project-b'));
		expect(second.objects).toHaveLength(2);
	});

	it('coalesces concurrent immutable catalog loads', async () => {
		const root = mkdtempSync(join(tmpdir(), 'knowledge-publication-coalescing-'));
		roots.push(root); process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT = root;
		const local = createLocalKnowledgePublicationStorage();
		const built = buildKnowledgePublication({ teamId: 'team-a', generatedAt: '2026-07-31T00:00:00.000Z',
			projects: snapshot(), graphRevisions: { 'project-a': 'graph-a' }, refs: { 'project-a': 'main' } });
		await local.publish({ manifest: built.manifest, objects: built.objects });
		const readObject = vi.fn(local.readObject.bind(local));
		const storage = { ...local, readObject };
		const input = { storage, manifest: built.manifest, teamSlug: 'team-a', projectIds: new Set(['project-a']) };
		const catalogs = await Promise.all(Array.from({ length: 20 }, () => loadPublishedTeamCatalog(input)));
		expect(catalogs.every((catalog) => catalog.revision === built.manifest.revision)).toBe(true);
		expect(readObject).toHaveBeenCalledTimes(built.manifest.entries.length);
	});
});
