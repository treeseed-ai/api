import { createHash } from 'node:crypto';
import type { KnowledgePublicationManifest } from '@treeseed/sdk/knowledge';
import { canonicalKnowledgePublicationValue } from './build-publication.ts';
import type { KnowledgePublicationStorage } from './publication-storage.ts';
import type { KnowledgeSnapshotProject } from '@treeseed/sdk/knowledge-packs';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const storageIds = new WeakMap<object, number>();
const catalogCache = new Map<string, { loadedAt: number; bytes: number; value: Promise<{ books: any[]; pages: any[]; revision: string }> }>();
let nextStorageId = 1;

function storageId(storage: object) {
	const existing = storageIds.get(storage);
	if (existing) return existing;
	const id = nextStorageId++;
	storageIds.set(storage, id);
	return id;
}

function cacheSettings() {
	return {
		maxEntries: Math.max(1, Number(process.env.TREESEED_KNOWLEDGE_CATALOG_CACHE_MAX_ENTRIES ?? 32) || 32),
		maxBytes: Math.max(1_048_576, Number(process.env.TREESEED_KNOWLEDGE_CATALOG_CACHE_MAX_BYTES ?? 67_108_864) || 67_108_864),
		ttlMs: Math.max(1_000, Number(process.env.TREESEED_KNOWLEDGE_CATALOG_CACHE_TTL_MS ?? 300_000) || 300_000),
	};
}

function pruneCatalogCache(maxEntries: number, maxBytes: number) {
	let bytes = [...catalogCache.values()].reduce((total, entry) => total + entry.bytes, 0);
	while (catalogCache.size > maxEntries || bytes > maxBytes) {
		const oldest = catalogCache.entries().next().value as [string, { bytes: number }] | undefined;
		if (!oldest) return;
		catalogCache.delete(oldest[0]);
		bytes -= oldest[1].bytes;
	}
}

async function parallelMap<T, R>(values: T[], concurrency: number, project: (value: T) => Promise<R>) {
	const results: R[] = [];
	for (let index = 0; index < values.length; index += concurrency) {
		results.push(...await Promise.all(values.slice(index, index + concurrency).map(project)));
	}
	return results;
}

async function publicationPayload(storage: KnowledgePublicationStorage, entry: any) {
	const body = await storage.readObject(entry.content.objectKey);
	if (!body || digest(body) !== entry.content.sha256 || Buffer.byteLength(body) !== entry.content.byteSize) {
		throw new Error(`Published knowledge object ${entry.id} is missing or corrupt.`);
	}
	return JSON.parse(body);
}

export async function loadPublishedTeamCatalog(input: { storage: KnowledgePublicationStorage;
	manifest: KnowledgePublicationManifest; teamSlug: string; projectIds: Set<string> }) {
	const settings = cacheSettings();
	const key = `${storageId(input.storage as object)}:${input.manifest.digest}:${input.teamSlug}:${[...input.projectIds].sort().join(',')}`;
	const cached = catalogCache.get(key);
	if (cached && Date.now() - cached.loadedAt <= settings.ttlMs) {
		catalogCache.delete(key);
		catalogCache.set(key, cached);
		return cached.value;
	}
	if (cached) catalogCache.delete(key);
	const value = loadPublishedTeamCatalogUncached(input);
	catalogCache.set(key, { loadedAt: Date.now(), bytes: 0, value });
	pruneCatalogCache(settings.maxEntries, settings.maxBytes);
	void value.then((payload) => {
		const current = catalogCache.get(key);
		if (!current || current.value !== value) return;
		current.bytes = Buffer.byteLength(JSON.stringify(payload));
		pruneCatalogCache(settings.maxEntries, settings.maxBytes);
	}).catch(() => undefined);
	value.catch(() => catalogCache.delete(key));
	return value;
}

async function loadPublishedTeamCatalogUncached(input: { storage: KnowledgePublicationStorage;
	manifest: KnowledgePublicationManifest; teamSlug: string; projectIds: Set<string> }) {
	const { digest: expectedDigest, ...unsigned } = input.manifest;
	if (digest(canonicalKnowledgePublicationValue(unsigned)) !== expectedDigest) {
		throw new Error('The knowledge publication manifest digest is invalid.');
	}
	const books: any[] = [];
	const pages: any[] = [];
	const entries = input.manifest.entries.filter((entry) => input.projectIds.has(entry.projectId));
	const loaded = await parallelMap(entries, 16, async (entry) => ({ entry, payload: await publicationPayload(input.storage, entry) }));
	for (const { entry, payload } of loaded) {
		const project = input.manifest.projects.find((candidate) => candidate.projectId === entry.projectId);
		if (!project || payload?.definition?.id !== entry.id || payload?.definition?.visibility !== entry.visibility
			|| payload?.definition?.status !== entry.status) {
			throw new Error(`Published knowledge object ${entry.id} does not match its manifest.`);
		}
		const item = { ...payload.definition, source: { teamId: input.manifest.teamId, teamSlug: input.teamSlug,
			projectId: entry.projectId, repositoryId: project.repositoryId, commitSha: project.commitSha,
			graphRef: project.ref, path: entry.sourcePath } };
		if (entry.kind === 'book') books.push(item);
		else pages.push(item);
	}
	return { books, pages, revision: input.manifest.revision };
}

export async function loadPublishedKnowledgeSnapshots(storage: KnowledgePublicationStorage,
	manifest: KnowledgePublicationManifest): Promise<KnowledgeSnapshotProject[]> {
	const projects = new Map(manifest.projects.map((project) => [project.projectId, {
		teamId: project.teamId, projectId: project.projectId, repositoryId: project.repositoryId,
		commitSha: project.commitSha, books: [], pages: [], bookSourcePaths: {},
	} as KnowledgeSnapshotProject]));
	const entries = manifest.entries.filter((entry) => entry.status === 'published');
	const loaded = await parallelMap(entries, 16, async (entry) => ({ entry, payload: await publicationPayload(storage, entry) }));
	for (const { entry, payload } of loaded) {
		const project = projects.get(entry.projectId);
		if (!project) throw new Error(`Published knowledge project ${entry.projectId} is missing.`);
		if (entry.kind === 'book') {
			project.books.push(payload.definition);
			project.bookSourcePaths![entry.id] = entry.sourcePath;
		} else project.pages.push({ definition: payload.definition, source: String(payload.sourceMarkdown ?? ''), sourcePath: entry.sourcePath });
	}
	return [...projects.values()];
}
