import { describe, expect, it } from 'vitest';
import { knowledgePublicationTransport } from '../../../../src/operations-runner/knowledge/publication-executor.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKnowledgePublicationManifest } from '../../../../src/api/knowledge/runtime/publication-manifest.ts';
import { createLocalKnowledgePublicationStorage } from '../../../../src/api/knowledge/publication-storage.ts';

function publicationInput() {
	return { schemaVersion: 'treeseed.knowledge-publication/v1', teamId: 'team', revision: 'revision',
		generatedAt: '2026-10-06T00:00:00.000Z', sourceClosure: 'closure', digest: 'digest',
		projects: [{ teamId: 'team', projectId: 'project', repositoryId: 'repository', ref: 'staging',
			commitSha: 'a'.repeat(40), graphRevision: 'graph', contentDigest: 'content' }],
		entries: [{ kind: 'page', id: 'page', bookId: 'book', visibility: 'team', status: 'published',
			projectId: 'project', sourcePath: 'knowledge/page.md',
			content: { objectKey: 'teams/team/objects/content', sha256: 'b'.repeat(64), byteSize: 5 } }],
		indexes: { public: [], authenticated: [], team: ['page'], project: [], admin: [] } };
}

function invalidPublicationInputs() {
	const inputs: unknown[] = [null, [], {}, { ...publicationInput(), schemaVersion: 'foreign' }];
	for (const field of ['teamId', 'revision', 'generatedAt', 'sourceClosure', 'digest'])
		for (const value of [undefined, '', ' ', null, 1]) inputs.push({ ...publicationInput(), [field]: value });
	for (const field of ['projects', 'entries']) for (const value of [undefined, null, {}, 'invalid'])
		inputs.push({ ...publicationInput(), [field]: value });
	for (const field of ['teamId', 'projectId', 'repositoryId', 'ref', 'commitSha', 'graphRevision', 'contentDigest'])
		for (const value of [undefined, '', null, 1]) inputs.push({ ...publicationInput(),
			projects: [{ ...publicationInput().projects[0], [field]: value }] });
	for (const field of ['id', 'bookId', 'projectId', 'sourcePath']) for (const value of [undefined, '', null, 1])
		inputs.push({ ...publicationInput(), entries: [{ ...publicationInput().entries[0], [field]: value }] });
	for (const field of ['kind', 'visibility', 'status', 'content']) inputs.push({ ...publicationInput(),
		entries: [{ ...publicationInput().entries[0], [field]: 'invalid' }] });
	for (const field of ['objectKey', 'sha256']) for (const value of [undefined, '', null, 1]) inputs.push({
		...publicationInput(), entries: [{ ...publicationInput().entries[0],
			content: { ...publicationInput().entries[0]!.content, [field]: value } }] });
	for (const byteSize of [undefined, null, '5', -1, 0.5, NaN, Infinity]) inputs.push({ ...publicationInput(),
		entries: [{ ...publicationInput().entries[0], content: { ...publicationInput().entries[0]!.content, byteSize } }] });
	for (const field of ['public', 'authenticated', 'team', 'project', 'admin']) inputs.push({ ...publicationInput(),
		indexes: { ...publicationInput().indexes, [field]: null } });
	return inputs;
}

describe('knowledge publication transport', () => {
	it('prefers a ready external publication binding over local managed storage', () => {
		expect(knowledgePublicationTransport(
			{ storageKind: 'managed', remoteUrl: null },
			'local',
			{ grant_status: 'ready', clone_url: 'https://github.com/treeseed-ai/api-library.git' },
		)).toBe('external');
	});

	it('keeps managed-only repositories local when no external binding is ready', () => {
		expect(knowledgePublicationTransport(
			{ storageKind: 'managed', remoteUrl: null },
			'local',
			null,
		)).toBe('managed-local');
	});
	it('owning publication reader preserves complete governed inputs and rejects missing malformed project entry and object custody without repair', () => {
		const input = publicationInput(), before = structuredClone(input);
		expect(parseKnowledgePublicationManifest(input)).toEqual({ ...input, previousRevision: undefined });
		for (const invalid of invalidPublicationInputs()) {
			const original = structuredClone(invalid);
			expect(() => parseKnowledgePublicationManifest(invalid)).toThrow();
			expect(invalid).toEqual(original);
		}
		const empty = { ...input, projects: [], entries: [], indexes: { ...input.indexes, team: [] } };
		expect(parseKnowledgePublicationManifest(empty)).toEqual({ ...empty, previousRevision: undefined });
		const normalized = { ...input, teamId: ' team ', previousRevision: ' prior ',
			indexes: { ...input.indexes, team: ['z', 'page', 'page', 'a'] } };
		expect(parseKnowledgePublicationManifest(normalized)).toEqual({ ...normalized, teamId: 'team', previousRevision: 'prior',
			indexes: { ...normalized.indexes, team: ['a', 'page', 'z'] } });
		expect(input).toEqual(before);
	});
	it('native publication storage refuses malformed retained manifest bytes and admits only restored exact custody without changing published objects or revisions', async () => {
		const root = await mkdtemp(join(tmpdir(), 'api-publication-custody-'));
		const prior = process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT;
		process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT = root;
		try {
			const input = publicationInput(), before = structuredClone(input);
			const manifest = parseKnowledgePublicationManifest(input), storage = createLocalKnowledgePublicationStorage();
			await storage.publish({ manifest, objects: [{ key: input.entries[0]!.content.objectKey, body: 'bytes' }] });
			const pointer = join(root, 'teams/team/published/common.json'), revision = join(root, 'teams/team/published/manifests/revision.json');
			const original = await readFile(pointer), revisionBytes = await readFile(revision);
			for (const invalid of invalidPublicationInputs()) {
				const bytes = Buffer.from(JSON.stringify(invalid));
				await writeFile(pointer, bytes);
				await expect(storage.readCurrent('team')).rejects.toThrow();
				expect(await readFile(pointer)).toEqual(bytes);
				expect(await readFile(revision)).toEqual(revisionBytes);
				expect(await storage.readObject(input.entries[0]!.content.objectKey)).toBe('bytes');
			}
			await writeFile(pointer, original);
			expect(await storage.readCurrent('team')).toEqual(manifest);
			expect(await storage.readRevision('team', 'revision')).toEqual(manifest);
			expect(await readFile(pointer)).toEqual(original);
			expect(await readFile(revision)).toEqual(revisionBytes);
			expect(input).toEqual(before);
		} finally {
			if (prior === undefined) delete process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT;
			else process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT = prior;
			await rm(root, { recursive: true, force: true });
		}
	});
});
