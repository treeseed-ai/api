import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { type KnowledgePublicationManifest } from '@treeseed/sdk/knowledge';
import { parseKnowledgePublicationManifest } from './runtime/publication-manifest.ts';
import { createR2KnowledgePublicationStorage } from './r2-publication-storage.ts';

export interface KnowledgePublicationStorage {
	readCurrent(teamId: string): Promise<KnowledgePublicationManifest | null>;
	readRevision(teamId: string, revision: string): Promise<KnowledgePublicationManifest | null>;
	listRevisions?(teamId: string): Promise<KnowledgePublicationManifest[]>;
	readObject(key: string): Promise<string | null>;
	publish(input: { manifest: KnowledgePublicationManifest; objects: Array<{ key: string; body: string }>;
		expectedRevision?: string }): Promise<void>;
	rollback(input: { teamId: string; revision: string; expectedRevision: string }): Promise<KnowledgePublicationManifest>;
	retireRevisions?(input: { teamId: string; revisions: string[]; expectedCurrentRevision: string }): Promise<{
		revisionsRemoved: string[]; objectsRemoved: string[];
	}>;
}

const safeSegment = (value: string) => {
	const segment = String(value).trim();
	if (!/^[a-zA-Z0-9._:-]+$/u.test(segment)) throw new Error('Unsafe knowledge publication storage segment.');
	return segment;
};

function localRoot() {
	return resolve(process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT?.trim() || '.treeseed/runtime/published-knowledge');
}

function inside(root: string, key: string) {
	const path = resolve(root, key);
	if (!path.startsWith(`${root}/`)) throw new Error('Knowledge publication path escaped its storage root.');
	return path;
}

const objectKeys = (manifest: KnowledgePublicationManifest) => new Set(manifest.entries.map((entry) => entry.content.objectKey));

async function json(path: string) {
	const body = await readFile(path, 'utf8').catch(() => null);
	return body ? parseKnowledgePublicationManifest(JSON.parse(body)) : null;
}

export function createLocalKnowledgePublicationStorage(): KnowledgePublicationStorage {
	const root = localRoot();
	return {
		async readCurrent(teamId) { return json(inside(root, `teams/${safeSegment(teamId)}/published/common.json`)); },
		async readRevision(teamId, revision) { return json(inside(root, `teams/${safeSegment(teamId)}/published/manifests/${safeSegment(revision)}.json`)); },
		async listRevisions(teamId) {
			const revisionRoot = inside(root, `teams/${safeSegment(teamId)}/published/manifests`);
			const files = await readdir(revisionRoot).catch(() => []);
			const manifests = await Promise.all(files.filter((entry) => entry.endsWith('.json'))
				.map((entry) => json(resolve(revisionRoot, entry))));
			return manifests.filter((manifest): manifest is KnowledgePublicationManifest => Boolean(manifest));
		},
		async readObject(key) { return readFile(inside(root, key), 'utf8').catch(() => null); },
		async publish({ manifest, objects, expectedRevision }) {
			const teamRoot = inside(root, `teams/${safeSegment(manifest.teamId)}`);
			await mkdir(teamRoot, { recursive: true, mode: 0o700 });
			const lockPath = resolve(teamRoot, '.publish.lock');
			let lock;
			try { lock = await open(lockPath, 'wx', 0o600); }
			catch { throw new Error('Another knowledge publication is currently being promoted.'); }
			try {
				const current = await json(resolve(teamRoot, 'published/common.json'));
				if ((current?.revision ?? undefined) !== expectedRevision) {
					throw new Error('The published knowledge revision changed while this publication was being built.');
				}
				for (const object of objects) {
					const path = inside(root, object.key);
					await mkdir(dirname(path), { recursive: true, mode: 0o700 });
					await writeFile(path, object.body, { flag: 'wx', mode: 0o600 }).catch(async (error: any) => {
						if (error?.code !== 'EEXIST' || await readFile(path, 'utf8') !== object.body) throw error;
					});
				}
				const revisionPath = resolve(teamRoot, `published/manifests/${safeSegment(manifest.revision)}.json`);
				await mkdir(dirname(revisionPath), { recursive: true, mode: 0o700 });
				const body = `${JSON.stringify(manifest, null, 2)}\n`;
				await writeFile(revisionPath, body, { flag: 'wx', mode: 0o600 }).catch(async (error: any) => {
					if (error?.code !== 'EEXIST' || await readFile(revisionPath, 'utf8') !== body) throw error;
				});
				const pending = resolve(teamRoot, `current.pending-${safeSegment(manifest.revision)}`);
				await writeFile(pending, body, { mode: 0o600 });
				await mkdir(resolve(teamRoot, 'published'), { recursive: true, mode: 0o700 });
				await rename(pending, resolve(teamRoot, 'published/common.json'));
			} finally {
				await lock?.close();
				await rm(lockPath, { force: true });
			}
		},
		async rollback({ teamId, revision, expectedRevision }) {
			const manifest = await this.readRevision(teamId, revision);
			if (!manifest) throw new Error('The requested knowledge publication revision was not found.');
			const current = await this.readCurrent(teamId);
			if (current?.revision !== expectedRevision) throw new Error('The published knowledge revision changed before rollback.');
			await this.publish({ manifest, objects: [], expectedRevision });
			return manifest;
		},
		async retireRevisions({ teamId, revisions, expectedCurrentRevision }) {
			const teamRoot = inside(root, `teams/${safeSegment(teamId)}`);
			const lockPath = resolve(teamRoot, '.publish.lock');
			let lock;
			try { lock = await open(lockPath, 'wx', 0o600); }
			catch { throw new Error('Another knowledge publication is currently being promoted.'); }
			try {
				const current = await json(resolve(teamRoot, 'published/common.json'));
				if (current?.revision !== expectedCurrentRevision) {
					throw new Error('The published knowledge revision changed before revision retirement.');
				}
				const requested = new Set(revisions.map(safeSegment));
				if (requested.has(current.revision)) throw new Error('The current knowledge revision cannot be retired.');
				if (current.previousRevision && requested.has(current.previousRevision)) {
					throw new Error('The current knowledge rollback pointer cannot be retired.');
				}
				const revisionRoot = resolve(teamRoot, 'published/manifests');
				const files = await readdir(revisionRoot).catch(() => []);
				const retainedObjects = objectKeys(current);
				const retiring: Array<{ revision: string; manifest: KnowledgePublicationManifest }> = [];
				for (const file of files.filter((entry) => entry.endsWith('.json'))) {
					const revision = file.slice(0, -5);
					const manifest = await json(resolve(revisionRoot, file));
					if (!manifest) continue;
					if (requested.has(revision)) retiring.push({ revision, manifest });
					else for (const key of objectKeys(manifest)) retainedObjects.add(key);
				}
				if (retiring.length !== requested.size) throw new Error('A requested knowledge revision was not found.');
				const candidateObjects = new Set(retiring.flatMap(({ manifest }) => [...objectKeys(manifest)]));
				const objectsRemoved: string[] = [];
				for (const key of candidateObjects) if (!retainedObjects.has(key)) {
					await rm(inside(root, key), { force: true });
					objectsRemoved.push(key);
				}
				for (const { revision } of retiring) await rm(resolve(revisionRoot, `${revision}.json`), { force: true });
				return { revisionsRemoved: retiring.map(({ revision }) => revision), objectsRemoved };
			} finally {
				await lock?.close();
				await rm(lockPath, { force: true });
			}
		},
	};
}

export function createKnowledgePublicationStorage(options: { adapter?: KnowledgePublicationStorage; environment?: string } = {}) {
	if (options.adapter) return options.adapter;
	const environment = options.environment ?? process.env.TREESEED_ENVIRONMENT ?? 'local';
	if (['local', 'test'].includes(environment)) return createLocalKnowledgePublicationStorage();
	return createR2KnowledgePublicationStorage();
}
